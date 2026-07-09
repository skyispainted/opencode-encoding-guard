// 测试 encoding-guard 插件的核心逻辑
// 运行: node --experimental-strip-types test.ts
// 必须从 test/ 目录运行（.encoding-rules 在 test/ 里）

import { readFile, writeFile, unlink, copyFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import iconv from "iconv-lite"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, "fixtures")

// ============== 1. 准备 fixtures ==============

const FILE_A = join(FIXTURES, "a.cpp")
const FILE_B = join(FIXTURES, "b.cpp")

// 用已知中文内容生成 GBK 文件
const contentA = `// 文件 A
#include <stdio.h>
int main() {
    printf("这是文件 A 的中文内容\\n");
    printf("测试编码转换\\n");
    return 0;
}
`
const contentB = `// 文件 B
#include <stdlib.h>
void foo() {
    // 另一个 GBK 文件
    system("echo 你好世界");
}
`

async function setup() {
  // 先加载插件
  const pluginModule = await import(pathToFileURL(join(__dirname, "..", "plugin", "encoding-guard.ts")).href)
  const pluginFactory = pluginModule.EncodingGuard

  // 初始化插件（传入 directory，模拟 opencode 加载）
  const hooks = await pluginFactory({ directory: FIXTURES } as any)

  // 写入 GBK fixtures
  await writeFile(FILE_A, iconv.encode(contentA, "gbk"))
  await writeFile(FILE_B, iconv.encode(contentB, "gbk"))

  return { hooks }
}

async function teardown() {
  try { await unlink(FILE_A) } catch {}
  try { await unlink(FILE_B) } catch {}
  try { await unlink(FILE_A + ".eg-backup") } catch {}
  try { await unlink(FILE_B + ".eg-backup") } catch {}
  try { await unlink(join(__dirname, "..", "plugin", "encoding-guard.inflight")) } catch {}
}

// ============== 2. 断言工具 ==============

let pass = 0
let fail = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`)
    pass++
  } else {
    console.log(`  ✗ ${msg}`)
    fail++
  }
}

// 检查文件是否仍是 GBK（不是 UTF-8）
// 用 round-trip：GBK 解码再编码回 GBK，应和原字节完全一致；且含预期中文
async function assertIsGBK(path: string, label: string) {
  const bytes = await readFile(path)
  const asGbk = iconv.decode(bytes, "gbk")
  const hasExpected = /中文|你好|测试|文件|编码|世界|修改|直接/.test(asGbk)
  // 去掉可能的 BOM 再比较
  const stripped = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    ? bytes.subarray(3)
    : bytes
  const reEncoded = iconv.encode(asGbk, "gbk")
  const roundTripOk = Buffer.compare(stripped, reEncoded) === 0
  assert(hasExpected && roundTripOk, `${label} 磁盘是 GBK（round-trip 字节一致 + 含预期中文）`)
}

async function assertIsUTF8(path: string, label: string) {
  const bytes = await readFile(path)
  const asUtf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  const utf8Ok = !asUtf8.includes("")
  assert(utf8Ok, `${label} 磁盘是 UTF-8（UTF-8 解码无替换符）`)
}

// ============== 3. 模拟 opencode 的 hook 调用 ==============

async function simulateRead(hooks: any, path: string) {
  const output: any = { output: "<original file content>" }
  // opencode 在内部完成 read 后调用 after hook
  await hooks["tool.execute.after"]({ tool: "read", args: { filePath: path } }, output)
  return output
}

async function simulateEdit(hooks: any, path: string, newContent: string) {
  // before hook：opencode 的 args 在第二个参数里
  const beforeOutput: any = { args: { filePath: path } }
  await hooks["tool.execute.before"]({ tool: "edit" }, beforeOutput)
  // 模拟 opencode edit 写入（opencode 写的是 UTF-8 字符串）
  await writeFile(path, Buffer.from(newContent, "utf-8"))
  // after hook：args 在第一个参数里
  const afterOutput: any = { output: "<edit diff>" }
  await hooks["tool.execute.after"]({ tool: "edit", args: { filePath: path } }, afterOutput)
  return afterOutput
}

async function simulateWrite(hooks: any, path: string, newContent: string) {
  // write 工具：LLM 给 UTF-8 字符串，直接写整个文件
  // before hook：args 在第二个参数里，content 字段是要写的内容
  const beforeOutput: any = { args: { filePath: path, content: newContent } }
  await hooks["tool.execute.before"]({ tool: "write" }, beforeOutput)
  // 模拟 opencode write：写入 content（可能被 before hook 改过）
  const contentToWrite = beforeOutput.args.content
  if (Buffer.isBuffer(contentToWrite)) {
    await writeFile(path, contentToWrite)
  } else {
    await writeFile(path, Buffer.from(contentToWrite, "utf-8"))
  }
  // after hook：args 在第一个参数里
  const afterOutput: any = { output: "<write ok>" }
  await hooks["tool.execute.after"]({ tool: "write", args: { filePath: path } }, afterOutput)
  return afterOutput
}

async function simulateApplyPatch(hooks: any, path: string) {
  // apply_patch：类似 edit，before 转 UTF-8，after 转回
  const beforeOutput: any = { args: { filePath: path, patch: "some patch" } }
  await hooks["tool.execute.before"]({ tool: "apply_patch" }, beforeOutput)
  // 模拟 opencode 应用 patch（会修改文件）
  const afterOutput: any = { output: "<patch applied>" }
  await hooks["tool.execute.after"]({ tool: "apply_patch", args: { filePath: path } }, afterOutput)
  return afterOutput
}

async function simulateGrep(hooks: any, path: string, output: string) {
  // grep：不修改文件，只读取并搜索
  const afterOutput: any = { output }
  await hooks["tool.execute.after"]({ tool: "grep", args: { paths: [path] } }, afterOutput)
  return afterOutput
}

// ============== 4. 测试用例 ==============

async function test1_ReadDoesNotMutateDisk(hooks: any) {
  console.log("\n[test 1] read 不改磁盘")
  const outA = await simulateRead(hooks, FILE_A)
  await assertIsGBK(FILE_A, "read A 后 A")
  assert(outA.output.includes("[EG:gbk]"), "read A 输出含 [EG:gbk] 标记")
  assert(/中文|测试/.test(outA.output), "read A 输出含正确中文（UTF-8 解码成功）")
}

async function test2_EditOnlyConvertsEditedFile(hooks: any) {
  console.log("\n[test 2] read A → read B → edit A，验证 A 和 B 都还是 GBK")
  console.log("         （旧 bug: edit.before 把 B 也转 UTF-8，但 edit.after 只转回 A，B 就泄漏了）")

  await simulateRead(hooks, FILE_A)
  await simulateRead(hooks, FILE_B)

  // 此时两个文件都应该是 GBK（read 不动磁盘）
  await assertIsGBK(FILE_A, "read A+B 后 A")
  await assertIsGBK(FILE_B, "read A+B 后 B  ← 旧 bug 死在这里")

  // 只 edit A
  const newContentA = `// 文件 A（已修改）
#include <stdio.h>
int main() {
    printf("修改后的内容\\n");
    return 0;
}
`
  await simulateEdit(hooks, FILE_A, newContentA)

  // A 应该还是 GBK
  await assertIsGBK(FILE_A, "edit A 后 A")
  // B 应该还是 GBK（旧 bug 会让 B 变成 UTF-8）
  await assertIsGBK(FILE_B, "edit A 后 B  ← 旧 bug 死在这里")

  // 验证 A 的内容确实被修改了
  const aBytes = await readFile(FILE_A)
  const aText = iconv.decode(aBytes, "gbk")
  assert(aText.includes("修改后的内容"), "edit A 后 A 的内容确实被更新")
}

async function test3_EditWithoutPriorRead(hooks: any) {
  console.log("\n[test 3] 直接 edit（没有先 read），应该能工作")

  // 重新写 fixture 确保是 GBK
  await writeFile(FILE_A, iconv.encode(contentA, "gbk"))

  const newContentA = `// 文件 A（直接 edit）
int x = 1;
`
  await simulateEdit(hooks, FILE_A, newContentA)

  await assertIsGBK(FILE_A, "直接 edit 后 A")
  const aBytes = await readFile(FILE_A)
  const aText = iconv.decode(aBytes, "gbk")
  assert(aText.includes("直接 edit"), "直接 edit 后内容更新")
}

async function test4_EditOutputPreservesDiff(hooks: any) {
  console.log("\n[test 4] edit.after 输出保留原 diff，并追加 EG 标记")

  await writeFile(FILE_A, iconv.encode(contentA, "gbk"))
  await simulateRead(hooks, FILE_A)  // 让 cache 有 A

  const output = await simulateEdit(hooks, FILE_A, "// changed\n")
  assert(output.output.includes("<edit diff>"), "保留原 edit 输出")
  assert(output.output.includes("[EG:edit]"), "追加 EG 标记")
  assert(output.output.includes("gbk"), "EG 标记含原编码名")
}

async function test5_WriteToolKeepsEncoding(hooks: any) {
  console.log("\n[test 5] write 工具：LLM 给 UTF-8，插件应转成 GBK 落盘")
  console.log("         （旧 bug：插件不 hook write，UTF-8 直接落盘 → 文件变 UTF-8）")

  // 先 read，让 cache 有 A
  await writeFile(FILE_A, iconv.encode(contentA, "gbk"))
  await simulateRead(hooks, FILE_A)

  // LLM 用 write 重写整个文件，给的是 UTF-8 字符串
  const newContent = "// 文件 A（被 write 重写）\n"
    + "#include <stdio.h>\n"
    + "int main() {\n"
    + '    printf("write 工具写入的中文\\n");\n'
    + "    return 0;\n"
    + "}\n"
  await simulateWrite(hooks, FILE_A, newContent)

  // 磁盘应该还是 GBK
  await assertIsGBK(FILE_A, "write 后 A")
  const bytes = await readFile(FILE_A)
  const text = iconv.decode(bytes, "gbk")
  assert(text.includes("write 工具写入的中文"), "write 后内容正确")
}

async function test6_ApplyPatchKeepsEncoding(hooks: any) {
  console.log("\n[test 6] apply_patch 工具：patch 前后应保持 GBK 编码")

  // 先 read，让 cache 有 A
  await writeFile(FILE_A, iconv.encode(contentA, "gbk"))
  await simulateRead(hooks, FILE_A)

  // 应用 patch
  await simulateApplyPatch(hooks, FILE_A)

  // 磁盘应该还是 GBK
  await assertIsGBK(FILE_A, "apply_patch 后 A")
}

async function test7_GrepDetectsEncoding(hooks: any) {
  console.log("\n[test 7] grep 工具：检测乱码并提示编码信息")

  // 准备 GBK 文件
  await writeFile(FILE_A, iconv.encode(contentA, "gbk"))
  await simulateRead(hooks, FILE_A)

  // 模拟 grep 返回包含乱码的输出（替换字符 ）
  const garbledOutput = "file.cpp:10:  some garbled text"
  const result = await simulateGrep(hooks, FILE_A, garbledOutput)

  // 应该包含编码提示
  assert(result.output.includes("[EG:grep]"), "grep 输出含 [EG:grep] 标记")
  assert(result.output.includes("gbk"), "grep 提示包含编码名 gbk")
}

// ============== 5. 主流程 ==============

async function main() {
  console.log("=== encoding-guard 插件测试 ===")
  console.log(`fixtures: ${FIXTURES}`)

  await teardown()  // 清掉上次残留
  const { hooks } = await setup()

  try {
    await test1_ReadDoesNotMutateDisk(hooks)
    // 重置 fixtures
    await writeFile(FILE_A, iconv.encode(contentA, "gbk"))
    await writeFile(FILE_B, iconv.encode(contentB, "gbk"))

    await test2_EditOnlyConvertsEditedFile(hooks)

    await test3_EditWithoutPriorRead(hooks)
    await test4_EditOutputPreservesDiff(hooks)
    await test5_WriteToolKeepsEncoding(hooks)
    await test6_ApplyPatchKeepsEncoding(hooks)
    await test7_GrepDetectsEncoding(hooks)
  } finally {
    await teardown()
  }

  console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`)
  if (fail > 0) process.exit(1)
}

main().catch(e => {
  console.error("TEST CRASH:", e)
  process.exit(2)
})
