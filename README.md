# encoding-guard 🛡️ — OpenCode 编码规则插件

> 基于规则文件的编码转换插件，按 glob 模式为文件指定原始编码，在读取/编辑时自动转换为 UTF-8。

[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-blue)](https://opencode.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 为什么需要它

Windows 简体中文环境下大量遗留文件以 **GBK** 编码保存，OpenCode 默认按 UTF-8 读取：

| 场景 | 问题 |
|------|------|
| `read` 读取 GBK 文件 | 中文显示 `锟斤拷` 乱码 |
| `edit` 编辑 GBK 文件 | `oldString` 匹配失败 |

本插件让你在项目根目录的 `.encoding-rules` 中手动配置哪些文件用什么编码，不再依赖不可靠的自动检测算法。

---

## 快速开始

### 一键安装

```powershell
# 在项目根目录执行
irm https://raw.githubusercontent.com/skyispainted/opencode-encoding-guard/main/scripts/install.ps1 | iex
```

### 配置规则

编辑项目根目录的 `.encoding-rules`：

```
# *.txt *.cs *.log 等文件按 GBK 解码
*.txt gbk
*.cs  gbk
*.log gbk

# 特定路径排除（! 取反，恢复默认 UTF-8）
!README.md gbk

# 递归匹配
src/**/*.ps1 gbk
```

### 重启 OpenCode

```
# 重启后插件自动加载 .encoding-rules
# read / edit 时自动按规则转换编码
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

Node.js `TextDecoder` 支持的所有编码名均可使用：

| 编码名 | 说明 |
|--------|------|
| `gbk` | 简体中文 (CP936) |
| `gb2312` | GB2312 |
| `big5` | 繁体中文 |
| `shift_jis` | 日文 |
| `euc-kr` | 韩文 |
| `windows-1251` | 俄文 (CP1251) |
| `iso-8859-1` | 西欧 |
| `utf8` | UTF-8 |

---

## 工作原理

```
启动 → 读取 .encoding-rules → 解析规则列表
   │
   ├─ read file.txt → 匹配 *.txt gbk → GBK 解码 → 输出 UTF-8 ✅
   ├─ edit file.txt → 匹配 *.txt gbk → 转 UTF-8 写回 → edit 匹配成功 ✅
   └─ edit README.md → 匹配 !README.md → 默认 UTF-8 → 原样处理
```

**`read` 工具**（`tool.execute.after` hook）：
- 读取后检测到乱码（U+FFFD 密度高）
- 按规则用对应编码重新解码
- 替换输出，LLM 看到正确内容

**`edit` 工具**（`tool.execute.before` hook）：
- 编辑前按规则检测编码
- 非 UTF-8 文件自动转换为 UTF-8 写回
- 后续编辑不再触发

**编码缓存**：同一文件（路径+mtime 不变）不重复处理。

---

## 手动安装

```powershell
# 1. 创建插件目录
mkdir -p .opencode/plugins

# 2. 下载插件
irm https://raw.githubusercontent.com/skyispainted/opencode-encoding-guard/main/plugin/encoding-guard.ts -OutFile .opencode/plugins/encoding-guard.ts

# 3. 下载规则模板
irm https://raw.githubusercontent.com/skyispainted/opencode-encoding-guard/main/.encoding-rules -OutFile .encoding-rules
```

## 卸载

```powershell
rm .opencode/plugins/encoding-guard.ts .encoding-rules
```

---

## 示例

**多语言项目**：

```
# 中文遗留代码
src/**/*.cs gbk
src/**/*.vb gbk

# 日志文件
logs/**/*.log gbk

# 特定文件
*.md  utf8
*.json utf8
```

**取反排除**：

```
# 所有 txt 都是 GBK
*.txt gbk

# 但这个是 UTF-8
!i18n.txt gbk
```

---

## 限制

| 限制 | 原因 | 变通 |
|------|------|------|
| `filesystem_read_text_file` 不受覆盖 | 该工具不触发 plugin hooks | 使用 `read` 替代 |
| 需手动配置规则 | 不再自动检测 | 按需编辑 `.encoding-rules` |
| 大文件（>1MB）跳过 | 避免 I/O 开销 | 按 UTF-8 处理 |
| 仅 `read` / `edit` | 其他工具使用较少 | 通过 skill 降级 |

---

## License

MIT © 2026
See [LICENSE](LICENSE) for full text.

---

*本方案完全由 OpenCode 设计、验证和文档化 — dogfooding 自举。*
