# encoding-guard 🛡️ — OpenCode 编码规则插件

> 基于规则文件的编码转换插件，按 glob 模式为文件指定原始编码，让 LLM 正确读写非 UTF-8 文件（如 GBK），同时保持磁盘文件编码不变。

[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-blue)](https://opencode.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 为什么需要它

Windows 简体中文环境下大量遗留文件以 **GBK** 编码保存，OpenCode 默认按 UTF-8 读取：

| 场景 | 问题 |
|------|------|
| `read` 读取 GBK 文件 | 中文显示 `锟斤拷` 乱码 |
| `edit` 编辑 GBK 文件 | `oldString` 匹配失败 |
| `write` 写入 GBK 文件 | 文件被改成 UTF-8，破坏原编码 |
| `grep` 搜索 GBK 文件 | 搜索结果乱码或找不到中文 |
| `apply_patch` 应用补丁 | 补丁应用到乱码内容上 |

本插件让你在项目根目录的 `.encoding-rules` 中手动配置哪些文件用什么编码，**不再依赖不可靠的自动检测算法**，让 LLM 能正确处理遗留编码文件。

---

## 核心功能

### 支持的工具

| 工具 | 行为 | 磁盘变化 |
|------|------|----------|
| **read** | 读取文件 → 按规则解码 → 输出 UTF-8 给 LLM | ❌ 不变 |
| **edit** | before: 临时转 UTF-8 → edit → after: 转回原编码 | ✅ 临时变 UTF-8，完成后恢复 |
| **write** | before: 拦截 UTF-8 内容 → 转成原编码写入 | ❌ 始终原编码 |
| **grep** | 重新实现 grep → 按规则解码文件 → 输出正确中文 | ❌ 不变 |
| **apply_patch** | before: 临时转 UTF-8 → patch → after: 转回原编码 | ✅ 临时变 UTF-8，完成后恢复 |

### 设计原则

- **磁盘保持原编码**：除了 edit/apply_patch 的临时转换，磁盘文件始终保持原始编码
- **LLM 看到 UTF-8**：所有输出给 LLM 的内容都是正确的 UTF-8
- **规则驱动**：通过 `.encoding-rules` 文件明确指定编码，不做自动检测
- **崩溃恢复**：临时转换期间崩溃，重启后自动恢复原文件

---

## 快速开始

### 1. 安装插件

```powershell
# 一键安装（推荐）
irm https://raw.githubusercontent.com/skyispainted/opencode-encoding-guard/main/scripts/install.ps1 | iex
```

安装脚本会：
- 全局安装 `iconv-lite` 到 `~/.config/opencode/node_modules/`
- 下载插件到 `~/.config/opencode/plugins/encoding-guard.ts`
- 在当前目录创建 `.encoding-rules` 模板

### 2. 配置规则

编辑项目根目录的 `.encoding-rules`：

```
# C/C++ 中文文件
*.cpp gbk
*.c   gbk
*.h   gbk

# 文本文件
*.txt gbk
*.log gbk

# 特定路径排除（! 取反，恢复默认 UTF-8）
!README.md gbk

# 递归匹配
src/**/*.cs gbk
```

### 3. 重启 OpenCode

```bash
# 重启后插件自动加载
# 读取/编辑/写入/搜索时自动按规则转换编码
```

---

## 规则语法

`.encoding-rules` 每行格式：

```
<glob-pattern> <encoding>
```

### 通配符

| 符号 | 含义 | 示例 |
|------|------|------|
| `*` | 匹配除 `/` 外的任意字符 | `*.txt` |
| `**` | 匹配任意层级目录 | `src/**/*.cs` |
| `?` | 匹配单个非 `/` 字符 | `?.md` |
| `!` | 取反（排除上方规则） | `!important.txt` |

### 匹配行为

- **从上到下匹配，最后一行生效**（同 `.gitignore`）
- 同时匹配 **完整路径** 和 **文件名**
- Windows 路径分隔符自动归一化
- 无规则文件或无匹配规则 → 默认 UTF-8

### 支持的编码

由 `iconv-lite` 提供，覆盖所有常见代码页：

| 编码名 | 说明 |
|--------|------|
| `gbk` / `gb2312` / `gb18030` | 简体中文 |
| `big5` | 繁体中文 |
| `shift_jis` / `euc-jp` | 日文 |
| `euc-kr` / `johab` | 韩文 |
| `windows-1250` ~ `windows-1258` | 各语言代码页 |
| `iso-8859-1` ~ `iso-8859-15` | 西欧 / 北欧 / 南欧等 |
| `koi8-r` / `koi8-u` | 俄文 |
| `utf8` | UTF-8 |

---

## 工作原理

### read 工具

```
LLM 调用 read("file.cpp")
  ↓
opencode 读取文件（得到乱码）
  ↓
插件 tool.execute.after 钩子触发
  ↓
读取 .encoding-rules → 匹配 *.cpp gbk
  ↓
用 iconv-lite 按 GBK 解码文件内容
  ↓
替换 output.output 为 UTF-8 内容
  ↓
LLM 看到正确的中文 ✅
磁盘文件保持 GBK 不变 ✅
```

**关键点**：
- 只修改输出，不修改磁盘
- 编码信息缓存到内存（`convertCache`）供后续工具使用

### edit / apply_patch 工具

```
LLM 调用 edit("file.cpp", old_string, new_string)
  ↓
插件 tool.execute.before 钩子触发
  ├─ 备份原文件 → file.cpp.eg-backup
  ├─ 读取 GBK 内容 → iconv 解码 → UTF-8
  ├─ 写入 UTF-8 到磁盘（临时）
  └─ 记录到 inflight 列表
  ↓
opencode 执行 edit（在 UTF-8 文件上操作）
  ↓
插件 tool.execute.after 钩子触发
  ├─ 读取 UTF-8 内容 → iconv 编码 → GBK
  ├─ 写入 GBK 到磁盘（恢复原编码）
  ├─ 删除备份文件
  └─ 从 inflight 列表移除
  ↓
LLM 看到 edit 成功 ✅
磁盘文件保持 GBK 不变 ✅
```

**崩溃恢复**：
- 如果进程在 edit 期间崩溃，磁盘可能停留在 UTF-8
- 下次启动时，插件扫描 `encoding-guard.inflight` 文件
- 自动用 `.eg-backup` 恢复原文件

### write 工具

```
LLM 调用 write("file.cpp", content)
  ↓
插件 tool.execute.before 钩子触发
  ├─ 读取 .encoding-rules → 匹配 *.cpp gbk
  ├─ 用 iconv-lite 将 UTF-8 内容编码为 GBK
  └─ 替换 hookOutput.args.content 为 GBK Buffer
  ↓
opencode 执行 write（写入 GBK 内容）
  ↓
插件 tool.execute.after 钩子触发（保险检查）
  ├─ 检查磁盘是否为 UTF-8
  ├─ 如果是，重新读取并转回 GBK
  └─ 确保最终磁盘是 GBK
  ↓
LLM 看到 write 成功 ✅
磁盘文件保持 GBK 不变 ✅
```

**双重保障**：
- before 钩子拦截内容并转换
- after 钩子检查磁盘状态，必要时再次修正

### grep 工具

```
LLM 调用 grep("*.cpp", "中文关键字")
  ↓
opencode 执行 grep（可能搜不到或乱码）
  ↓
插件 tool.execute.after 钩子触发
  ├─ 读取 .encoding-rules → 获取所有匹配文件的编码
  ├─ 对每个文件：用正确编码读取 → 重新搜索
  ├─ 生成标准 grep 格式输出：文件:行号:内容
  └─ 替换 output.output
  ↓
LLM 看到正确的搜索结果 ✅
磁盘文件保持 GBK 不变 ✅
```

**完全重写 grep**：
- 不复用 opencode 的 grep 结果（可能乱码）
- 自己读取文件、解码、搜索、生成输出
- 确保 LLM 看到正确的中文内容

---

## 完整工作流程

```
项目目录/
├── .encoding-rules          # 编码规则配置
├── src/
│   ├── main.cpp            # GBK
│   └── utils.h             # GBK
└── README.md               # UTF-8

.encoding-rules 内容：
  *.cpp gbk
  *.h   gbk

工作流：
  1. read src/main.cpp
     → 插件解码 GBK → LLM 看到 UTF-8 ✅
  
  2. grep *.cpp "函数名"
     → 插件重新搜索 → LLM 看到正确结果 ✅
  
  3. edit src/main.cpp
     → 临时转 UTF-8 → edit → 转回 GBK ✅
  
  4. write src/new.cpp (UTF-8 内容)
     → 插件拦截 → 写入 GBK ✅
  
  5. apply_patch src/utils.h
     → 临时转 UTF-8 → patch → 转回 GBK ✅
```

---

## 文件结构

安装后的文件：

```
~/.config/opencode/
├── plugins/
│   └── encoding-guard.ts      # 插件主文件
├── node_modules/
│   └── iconv-lite/            # 编码转换库
└── encoding-guard.log         # 运行日志（可选）

项目目录/
└── .encoding-rules            # 编码规则配置
```

**临时文件**（edit/apply_patch 期间）：
- `file.eg-backup` - 原文件备份
- `encoding-guard.inflight` - 记录正在转换的文件（崩溃恢复用）

---

## 手动安装

```powershell
# 1. 安装 iconv-lite
cd ~/.config/opencode
npm install iconv-lite

# 2. 下载插件
irm https://raw.githubusercontent.com/skyispainted/opencode-encoding-guard/main/plugin/encoding-guard.ts -OutFile plugins/encoding-guard.ts

# 3. 在项目目录创建规则
echo "*.cpp gbk" > .encoding-rules
```

## 卸载

```powershell
# 删除插件和依赖
rm ~/.config/opencode/plugins/encoding-guard.ts
rm -r ~/.config/opencode/node_modules/iconv-lite

# 删除项目规则（可选）
rm .encoding-rules
```

---

## 配置示例

### 多语言项目

```
# 中文遗留代码
src/**/*.cs gbk
src/**/*.vb gbk
src/**/*.cpp gbk

# 日志文件
logs/**/*.log gbk

# 特定文件保持 UTF-8
*.md  utf8
*.json utf8
```

### 取反排除

```
# 默认 GBK
*.txt gbk

# 但 i18n.txt 是 UTF-8
!i18n.txt utf8
```

### 复杂路径

```
# 只匹配特定子目录
legacy/**/*.c gbk
new-code/**/*.c utf8

# 匹配特定文件名
!Makefile utf8
```

---

## 限制与注意事项

| 限制 | 原因 | 变通方案 |
|------|------|----------|
| MCP 工具不受控制 | MCP 工具自己管理编码 | 不适用本插件 |
| 需手动配置规则 | 不做自动检测 | 按需编辑 `.encoding-rules` |
| 大文件（>1MB）跳过 | 避免 I/O 开销 | 按 UTF-8 处理 |
| edit 期间磁盘临时为 UTF-8 | opencode edit 工具需要 UTF-8 | 完成后自动恢复 |
| 需要 iconv-lite | Node.js 原生不支持 GBK 写入 | 安装脚本自动处理 |

---

## 故障排查

### 查看日志

```powershell
# 查看插件日志
cat ~/.config/opencode/encoding-guard.log

# 清空日志
rm ~/.config/opencode/encoding-guard.log
```

### 常见问题

**Q: 文件还是乱码？**
- 检查 `.encoding-rules` 是否在项目根目录
- 检查规则是否匹配到文件（看日志中的 `after read: cached`）
- 重启 OpenCode 让规则生效

**Q: edit 后文件编码变了？**
- 查看日志是否有 `convertBack ERROR`
- 检查是否有 `.eg-backup` 残留文件
- 查看 `encoding-guard.inflight` 是否有残留记录

**Q: 崩溃后文件损坏？**
- 重启 OpenCode，插件会自动恢复
- 查看日志中的 `recovered` 记录
- 检查 `.eg-backup` 文件是否存在

---

## 开发

### 运行测试

```bash
# 安装依赖
cd ~/.config/opencode
npm install

# 运行测试
cd /path/to/opencode-encoding-guard
node --experimental-strip-types test/test.ts
```

### 测试覆盖

- ✅ read 不改磁盘，输出正确 UTF-8
- ✅ edit 只转换当前文件，不污染其他缓存文件
- ✅ write 拦截 UTF-8 内容，写入原编码
- ✅ apply_patch 临时转换，完成后恢复
- ✅ grep 重新实现搜索，输出正确中文
- ✅ 直接 edit（无前置 read）也能工作
- ✅ edit.after 保留原 diff，追加 EG 标记

---

## License

MIT © 2026
See [LICENSE](LICENSE) for full text.

---

*本方案完全由 OpenCode 设计、验证和文档化 — dogfooding 自举。*
