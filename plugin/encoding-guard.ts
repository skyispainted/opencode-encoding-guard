import type { Plugin } from "@opencode-ai/plugin"
import { readFile, stat } from "node:fs/promises"
import { existsSync, writeFileSync, appendFileSync, copyFileSync, unlinkSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import iconv from "iconv-lite"

const MAX_DETECT_SIZE = 1 * 1024 * 1024
const RULES_FILE = ".encoding-rules"
const BASE_DIR = typeof import.meta.dirname === 'string' ? import.meta.dirname : '.'
const LOG_FILE = BASE_DIR + "/encoding-guard.log"
const INFLIGHT_FILE = BASE_DIR + "/encoding-guard.inflight"
const BACKUP_SUFFIX = ".eg-backup"

function log(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

const convertCache = new Map<string, string>()
const utf8OnDisk = new Set<string>()

// 记录当前"磁盘是 UTF-8、原文件在 .eg-backup"的路径集合
// 写到磁盘上，用于崩溃后重启时自动恢复
function addInflight(path: string) {
  try {
    let lines: string[] = []
    if (existsSync(INFLIGHT_FILE)) {
      lines = readFileSync(INFLIGHT_FILE, "utf-8").split("\n").filter(Boolean)
    }
    if (!lines.includes(path)) {
      lines.push(path)
      writeFileSync(INFLIGHT_FILE, lines.join("\n") + "\n")
    }
  } catch {}
}

function removeInflight(path: string) {
  try {
    if (!existsSync(INFLIGHT_FILE)) return
    const lines = readFileSync(INFLIGHT_FILE, "utf-8").split("\n").filter(Boolean)
    const next = lines.filter(p => p !== path)
    if (next.length === 0) {
      unlinkSync(INFLIGHT_FILE)
    } else {
      writeFileSync(INFLIGHT_FILE, next.join("\n") + "\n")
    }
  } catch {}
}

// 启动时扫描 inflight 文件，把上次崩溃残留的 UTF-8 磁盘文件恢复成原编码备份
async function recoverFromCrash() {
  if (!existsSync(INFLIGHT_FILE)) return
  try {
    const lines = readFileSync(INFLIGHT_FILE, "utf-8").split("\n").filter(Boolean)
    if (!lines.length) return
    for (const path of lines) {
      const backupPath = path + BACKUP_SUFFIX
      if (existsSync(backupPath)) {
        try {
          copyFileSync(backupPath, path)
          unlinkSync(backupPath)
          log(`recovered ${path} from backup on startup`)
        } catch (e: any) {
          log(`recover FAILED for ${path}: ${e.message}`)
        }
      } else {
        log(`no backup found for inflight ${path}, skipping`)
      }
    }
    unlinkSync(INFLIGHT_FILE)
  } catch (e: any) {
    log(`recoverFromCrash ERROR: ${e.message}`)
  }
}

interface Rule {
  pattern: string
  encoding: string
  negated: boolean
}

let rules: Rule[] = []

function globToRegex(pattern: string): RegExp {
  let regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  regex = regex.replace(/\*\*/g, "__GS__")
  regex = regex.replace(/\*/g, "[^/]*")
  regex = regex.replace(/\?/g, "[^/]")
  regex = regex.replace(/__GS__/g, ".*")
  return new RegExp(`^${regex}$`)
}

function matchRule(filePath: string): string {
  if (!rules.length) return "utf8"
  const normalized = filePath.replace(/\\/g, "/")
  const basename = normalized.split("/").pop() || ""
  let result = "utf8"
  for (const rule of rules) {
    const re = globToRegex(rule.pattern)
    if (re.test(normalized) || re.test(basename)) {
      result = rule.negated ? "utf8" : rule.encoding
    }
  }
  return result
}

async function findRules(filePath: string): Promise<void> {
  if (rules.length > 0) return
  let dir = dirname(filePath)
  for (let i = 0; i < 10; i++) {
    const rp = join(dir, RULES_FILE)
    if (existsSync(rp)) {
      try {
        const content = await readFile(rp, "utf-8")
        rules = content.split("\n")
          .map(l => l.trim())
          .filter(l => l.length > 0 && !l.startsWith("#"))
          .map(line => {
            const si = line.indexOf(" ")
            if (si === -1) return null
            const pat = line.slice(0, si)
            const enc = line.slice(si + 1).trim().toLowerCase()
            const neg = pat.startsWith("!")
            return { pattern: neg ? pat.slice(1) : pat, encoding: enc, negated: neg }
          })
          .filter(Boolean) as Rule[]
        return
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

async function convertToUtf8OnDisk(path: string, encoding: string): Promise<boolean> {
  if (encoding === "utf8") return false
  try {
    const s = await stat(path)
    if (s.size > MAX_DETECT_SIZE) return false
    // 备份原文件，用于崩溃恢复
    const backupPath = path + BACKUP_SUFFIX
    copyFileSync(path, backupPath)
    const buffer = await readFile(path)
    const text = iconv.decode(buffer, encoding)
    writeFileSync(path, Buffer.from(text, "utf-8"))
    utf8OnDisk.add(path)
    convertCache.set(path, encoding)
    addInflight(path)
    log(`converted ${path} ${encoding}->UTF-8 on disk (backup: ${backupPath})`)
    return true
  } catch (e: any) {
    log(`convertToUtf8 ERROR: ${e.message}`)
    return false
  }
}

async function convertBack(path: string, encoding: string): Promise<boolean> {
  const backupPath = path + BACKUP_SUFFIX
  try {
    const buffer = await readFile(path)
    const text = buffer.toString("utf-8")
    const encoded = iconv.encode(text, encoding)
    writeFileSync(path, encoded)
    utf8OnDisk.delete(path)
    convertCache.delete(path)
    // 转换成功，清理备份
    try { unlinkSync(backupPath) } catch {}
    removeInflight(path)
    log(`converted ${path} UTF-8->${encoding} on disk (backup removed)`)
    return true
  } catch (e: any) {
    log(`convertBack ERROR: ${e.message}, attempting restore from backup`)
    // 转换失败，用备份恢复原文件
    if (existsSync(backupPath)) {
      try {
        copyFileSync(backupPath, path)
        unlinkSync(backupPath)
        utf8OnDisk.delete(path)
        convertCache.delete(path)
        removeInflight(path)
        log(`restored ${path} from backup`)
      } catch (restoreErr: any) {
        log(`restore FAILED: ${restoreErr.message}`)
      }
    }
    return false
  }
}

log("=== PLUGIN LOADED ===")
recoverFromCrash()

export const EncodingGuard: Plugin = async (input) => {
  log(`plugin init: directory=${input.directory}`)

  return {
    "tool.execute.before": async (hookInput: any, hookOutput: any) => {
      try {
        log(`before: tool=${hookInput.tool}, sessionID=${hookInput.sessionID}, callID=${hookInput.callID}`)

        if (hookInput.tool === "edit") {
          // opencode 的 before hook：args 在第二个参数里
          const path = hookOutput?.args?.filePath
          if (path && existsSync(path)) {
            let encoding = convertCache.get(path)
            if (!encoding) {
              await findRules(path)
              encoding = matchRule(path)
              if (encoding !== "utf8") convertCache.set(path, encoding)
            }
            if (encoding !== "utf8" && !utf8OnDisk.has(path)) {
              log(`before edit: converting ${path} ${encoding}->UTF-8`)
              await convertToUtf8OnDisk(path, encoding)
            }
          } else {
            log(`before edit: no path (path=${path})`)
          }
        }
      } catch (e: any) {
        log(`before hook CRASH: ${e.message}`)
      }
    },

    "tool.execute.after": async (hookInput: any, output: any) => {
      try {
        if (hookInput.tool === "read") {
          const path = hookInput.args?.filePath
          if (!path || !existsSync(path)) return
          await findRules(path)
          const encoding = matchRule(path)
          const buffer = await readFile(path)
          const text = encoding === "utf8"
            ? buffer.toString("utf-8")
            : iconv.decode(buffer, encoding)
          const lines = text.replace(/\r\n/g, "\n").split("\n")
          const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n")
          output.output = `[EG:${encoding}] <path>${path}</path>\n<type>file</type>\n<content>\n${numbered}\n\n(End of file - total ${lines.length} lines)\n</content>`

          if (encoding !== "utf8") {
            convertCache.set(path, encoding)
            log(`after read: cached ${path}=${encoding}, cacheSize=${convertCache.size}`)
          }
          return
        }

        if (hookInput.tool === "edit") {
          const path = hookInput.args?.filePath
          log(`after edit: path=${path}`)
          if (!path || !existsSync(path)) return
          if (!convertCache.has(path)) {
            log(`after edit: not in cache, skipping`)
            return
          }
          const origEncoding = convertCache.get(path)!
          await convertBack(path, origEncoding)
          const prev = typeof output?.output === "string" ? output.output : ""
          output.output = prev ? `${prev}\n\n[EG:edit] wrote ${path} as ${origEncoding}` : `[EG:edit] wrote ${path} as ${origEncoding}`
        }
      } catch (e: any) {
        log(`after hook CRASH: ${e.message}`)
      }
    },
  }
}
