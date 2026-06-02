# encoding-guard 🛡️ — OpenCode 编码守卫插件

> 自动检测并修正 GBK 编码文件，解决 Windows 中文环境下 `read` 乱码和 `edit` 匹配失败。
>
> Auto-detect legacy multi-byte encodings and convert to UTF-8 on-the-fly.
> Also relevant for Japanese (Shift-JIS) and Korean (EUC-KR) users.

[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-blue)](https://opencode.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 问题 / Problem

Windows 简体中文环境下，系统默认代码页为 **GBK (CP936)**，大量遗留文本文件以 GBK 编码保存。
OpenCode 默认以 UTF-8 解析所有文件，导致：

| 场景 | 现象 | 根因 |
|------|------|------|
| `read` 读取 | 中文显示为 `锟斤拷` 乱码 | Node.js `readFileSync` 以 UTF-8 解析 GBK 字节 |
| `edit` 替换 | `oldString` 匹配失败 | `edit` 读取文件原始字节，与 LLM 传入的 UTF-8 文本不匹配 |

---

## 方案 / Solution

一个轻量 OpenCode 插件，拦截 `read` 和 `edit` 工具调用，自动检测并修正编码。

### 检测算法

```
原始字节 → TextDecoder("utf-8").decode()
    ↓
统计 U+FFFD 替换字符占比
    ↓
≥ 50% → 判定为 GBK → 以 GBK 重新解码 → 输出 UTF-8
< 50% → 保持 UTF-8
```

- **U+FFFD 密度 > 50%**: 可靠区分 GBK 与 UTF-8（GBK 双字节字符几乎全部映射为 U+FFFD）
- **文件 > 1MB**: 跳过检测，假定为 UTF-8

### 架构

```
LLM calls `read(path)`
    │
    ├─ read tool 执行 ────────────────────────────────
    ├─ tool.execute.after ─────────────────────────────
    │   检查输出 FF FD 密度 → 异步重读 GBK → 替换输出
    │   （异步 I/O + 编码缓存，零阻塞）
    LLM 看到正确中文 ✅

LLM calls `edit(path, oldString)`
    │
    ├─ tool.execute.before ────────────────────────────
    │   异步检测 GBK 缓存 → 若 GBK 则转换写回 UTF-8 无 BOM
    ├─ edit tool 读取 UTF-8 文件 → 匹配成功 ✅
```

- **`read`**: 后置修复（`after` hook），无预读双倍 I/O；异步非阻塞；保持原生输出格式
- **`edit`**: 永久修复，文件转换为 UTF-8，后续不再触发
- **编码缓存**: 同一文件（路径+mtime 不变）不重复检测，降低 I/O 开销
- **所有 hook 使用 `node:fs/promises` 异步 API**，不阻塞 UI 事件循环

---

## 安装指引（OpenCode 自动配置）

将以下内容**逐段复制**粘贴给 OpenCode，它将自动完成：

> 请按顺序执行：
>
> **Step 1**: 用 `webfetch` 读取以下 URL，将内容写入 `.opencode/plugins/encoding-guard.ts`
>
> ```
> https://raw.githubusercontent.com/你的用户名/opencode-encoding-guard/main/plugin/encoding-guard.ts
> ```
>
> **Step 2**: 用 `webfetch` 读取以下 URL，将内容写入 `.opencode/skills/cjk-edit/SKILL.md`
>
> ```
> https://raw.githubusercontent.com/你的用户名/opencode-encoding-guard/main/skill/SKILL.md
> ```
>
> **Step 3**: 同理创建以下两个文件：
> - `tools/detect-encoding.ps1` ← `.../scripts/detect-encoding.ps1`
> - `tools/write-safe.ps1` ← `.../scripts/write-safe.ps1`
>
> **Step 4**: 重启 opencode，使插件生效
>
> **Step 5**: 验证（见下方验证章节）

> **Hint**: OpenCode 自动扫描 `.opencode/plugins/` 目录加载插件，无需修改配置文件。

---

## Manual Installation

1. Copy `plugin/encoding-guard.ts` → `.opencode/plugins/encoding-guard.ts`
2. Copy `skill/SKILL.md` → `.opencode/skills/cjk-edit/SKILL.md`
3. Copy `scripts/detect-encoding.ps1` → `tools/detect-encoding.ps1`
4. Copy `scripts/write-safe.ps1` → `tools/write-safe.ps1`
5. Restart OpenCode

---

## 验证 / Verification

```powershell
# 1. 创建 GBK 测试文件
$content = "这是GBK编码的中文测试文件`r`n第二行：验证`r`nEND"
[System.IO.File]::WriteAllBytes("test-gbk.txt", [System.Text.Encoding]::GetEncoding(936).GetBytes($content))

# 2. 在 OpenCode 中用 read 读取 → 应显示中文，无乱码
read("test-gbk.txt")

# 3. 用 edit 替换中文字符串 → 应成功
edit(filePath="test-gbk.txt", oldString="验证", newString="成功")

# 4. 确认文件已转为 UTF-8
#    原 51 bytes → 转换后 ≈65 bytes，无 U+FFFD
```

---

## 限制 / Limitations

| 限制 | 原因 | 变通 |
|------|------|------|
| `filesystem_read_text_file` 不受覆盖 | 该工具的 hook 不触发 plugin hooks | 在 skill 中引导使用 `read` |
| 仅支持 GBK | 无法可靠自动判定 Shift-JIS/EUC-KR | 可按需扩展 `detectGbk()` 函数 |
| 大文件（>1MB）跳过检测 | 避免 I/O 开销 | 按预期 UTF-8 处理 |
| 仅 `read` 和 `edit` | `filesystem_edit_file` 使用较少 | 可通过 skill 降级链路覆盖 |

---

## License

MIT © 2026
See [LICENSE](LICENSE) for full text.

---

*本方案完全由 OpenCode 设计、验证和文档化 — dogfooding 自举。*
