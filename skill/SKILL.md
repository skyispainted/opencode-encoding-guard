---
name: cjk-edit
description: >
  CJK 文本文件编码规范 — 读取/写入/编辑全链路自动化。
  encoding-guard 插件基于 .encoding-rules 规则文件处理编码，skill 覆盖兜底 SOP。
---

## 0. 前提

**本项目文件编码原则**：所有文本文件统一为 **UTF-8 无 BOM**。这是读、写、编辑三者的基准编码。

`encoding-guard.ts` 插件（`.opencode/plugins/encoding-guard.ts`）基于 `.encoding-rules` 规则文件处理编码：
- **规则文件**: 项目根目录 `.encoding-rules`，gitignore 风格的 glob 模式匹配
- **读取**（A 类）：拦截 `read` 工具输出（`tool.execute.after`），按规则判定编码，异步重读后替换输出
- **编辑**（B 类）：拦截 `edit` 工具（`tool.execute.before`），按规则检测编码后在匹配前一次性转为 UTF-8
- **异步 I/O + 编码缓存**（路径+mtime键控）：同一文件不重复检测，零事件循环阻塞
- **全异步非阻塞**：`node:fs/promises`，不阻塞 UI 线程，零闪屏

下列旧工具/脚本已被插件替代，不再为日常路径。skill 中保留仅为 `filesystem_read_text_file` 场景和手动降级兜底。

---

## 1. 读取

### 首选 `read` 工具
`read` 经 `encoding-guard` 插件加持可自动识别 GBK。始终优先使用。

### `.encoding-rules` 规则
插件启动时读取规则文件，按 glob 模式匹配文件路径确定编码。未匹配的文件默认 utf8。
确保规则文件中包含正确的编码配置。

### `filesystem_read_text_file` 回退
此工具不受插件覆盖。若因工具限制需使用它读取含 CJK 的文件，且返回乱码：
1. 手动用 `tools/detect-encoding.ps1` 鉴定编码（参见附录 A）
2. 若为 GBK，改用 `read` 或 bash `Get-Content -Encoding GBK` 读取

---

## 2. 写入

### 首选平台工具
| 操作 | 工具 | 编码 |
|------|------|------|
| 写入 | `filesystem_write_file` | **UTF-8 无 BOM**（默认） |
| 备份 (`.md`/`.json`) | `filesystem_copy_file → .bak` | 不改变编码 |

### PowerShell 降级
仅当 `filesystem_*` 失败时使用：
```powershell
. "$Env:PROJECT_ROOT/tools/write-safe.ps1"
Write-SafeFile -Path "目标文件" -Content $newContent
```

### 显式编码指定
任何 PowerShell 文件操作（`Get-Content` / `Set-Content` / `Out-File`）必须显式指定编码：

| 场景 | 正确 |
|------|------|
| 读取 | `-Encoding utf8` 或 `-Encoding GBK` |
| 写入 | `-Encoding utf8` 或 `[UTF8Encoding]::new($false)` |
| 禁止 | 不带 `-Encoding` 参数的 `Get-Content`/`Set-Content` |

---

## 3. 编辑

**`edit` 工具在操作前按 `.encoding-rules` 规则检测文件编码：若非 UTF-8 则一次性转为 UTF-8 再执行匹配。** 这由 `encoding-guard` 插件实现。

以下 SOP 仅在 `edit` 匹配失败时使用（作为兜底链路）。

### 3.1 首次尝试：短匹配原则
```
❌ 含中文标点的完整句子
   oldString: - **批判性评估**：... [cite: 2026-01-15]

✅ 纯 ASCII 关键字 + 唯一标识
   oldString: [cite: 2026-01-15]
```

### 3.2 失败恢复链路
```
edit 工具报 "could not find oldString"
   ├─ 步骤1：尝试 replaceAll: true
   ├─ 步骤2：用纯 ASCII 关键字重新定位
   └─ 步骤3：降级至 filesystem_edit_file → bash Get-Content + 替换
```

---

## 4. PS Unicode 陷阱

PowerShell 字符串操作对 CJK 字符存在 culture-sensitive 陷阱。

| 场景 | 正确做法 | 错误做法 |
|------|----------|----------|
| CJK 字符串 IndexOf | `$s.IndexOf("中", [StringComparison]::Ordinal)` | `$s.IndexOf("中")`（culture-sensitive） |
| 字面替换 | `$s.Replace("旧","新")`（.NET 方法） | `$s -replace "旧"`（regex，含特殊字符时出错） |
| 文件写编码 | `[UTF8Encoding]::new($false)` | `[Encoding]::UTF8`（产生 BOM） |

---

## 附录 A：工具状态清单

| 工具/脚本 | 状态 | 保留原因 |
|-----------|------|----------|
| `tools/detect-encoding.ps1` | ⚠️ 已废弃（插件替代） | `filesystem_read_text_file` 手动回退时仍可用 |
| `tools/write-safe.ps1` | ✅ 保留 | PowerShell 写入降级的兜底入口 |
| `encoding-guard.ts` | ✅ 正式插件 | A/B 类自动化，基于 .encoding-rules 规则文件 |
| `.encoding-rules` | ✅ 规则文件 | 手动配置的编码匹配规则，gitignore 风格语法 |
