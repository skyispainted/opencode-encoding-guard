import type { Plugin } from "@opencode-ai/plugin"
import { readFile, stat } from "node:fs/promises"
import { existsSync, writeFileSync, appendFileSync } from "node:fs"
import { join, dirname } from "node:path"
import iconv from "iconv-lite"

const MAX_DETECT_SIZE = 1 * 1024 * 1024
const RULES_FILE = ".encoding-rules"
const LOG_FILE = (typeof import.meta.dirname === 'string' ? import.meta.dirname : '.') + "/encoding-guard.log"

function log(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

const convertCache = new Map<string, string>()
const utf8OnDisk = new Set<string>()

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

function decodeBuffer(buffer: Buffer, encoding: string): string {
  if (encoding === "utf8") return new TextDecoder("utf-8", { fatal: false }).decode(buffer)
  const upper = encoding.toUpperCase().replace("-", "")
  return new TextDecoder(upper, { fatal: false }).decode(buffer)
}

async function convertToUtf8OnDisk(path: string, encoding: string): Promise<boolean> {
  if (encoding === "utf8") return false
  try {
    const s = await stat(path)
    if (s.size > MAX_DETECT_SIZE) return false
    const buffer = await readFile(path)
    const text = decodeBuffer(buffer, encoding)
    writeFileSync(path, Buffer.from(text, "utf-8"))
    utf8OnDisk.add(path)
    convertCache.set(path, encoding)
    log(`converted ${path} ${encoding}->UTF-8 on disk`)
    return true
  } catch (e: any) {
    log(`convertToUtf8 ERROR: ${e.message}`)
    return false
  }
}

async function convertBack(path: string, encoding: string): Promise<boolean> {
  try {
    const buffer = await readFile(path)
    const text = buffer.toString("utf-8")
    const encoded = iconv.encode(text, encoding)
    writeFileSync(path, encoded)
    utf8OnDisk.delete(path)
    convertCache.delete(path)
    log(`converted ${path} UTF-8->${encoding} on disk`)
    return true
  } catch (e: any) {
    log(`convertBack ERROR: ${e.message}`)
    return false
  }
}

log("=== PLUGIN LOADED ===")

export const EncodingGuard: Plugin = async (input) => {
  log(`plugin init: directory=${input.directory}`)

  return {
    "tool.execute.before": async (hookInput: any) => {
      log(`before: tool=${hookInput.tool}, sessionID=${hookInput.sessionID}, callID=${hookInput.callID}`)

      if (hookInput.tool === "edit") {
        for (const [path, encoding] of new Map(convertCache)) {
          if (!utf8OnDisk.has(path) && existsSync(path)) {
            await convertToUtf8OnDisk(path, encoding)
          }
        }
      }
    },

    "tool.execute.after": async (hookInput: any, output: any) => {
      if (hookInput.tool === "read") {
        const path = hookInput.args?.filePath
        if (!path || !existsSync(path)) return
        try {
          await findRules(path)
          const encoding = matchRule(path)
          const buffer = await readFile(path)
          const text = decodeBuffer(buffer, encoding)
          const lines = text.replace(/\r\n/g, "\n").split("\n")
          const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n")
          output.output = `[EG:${encoding}] <path>${path}</path>\n<type>file</type>\n<content>\n${numbered}\n\n(End of file - total ${lines.length} lines)\n</content>`

          if (encoding !== "utf8") {
            await convertToUtf8OnDisk(path, encoding)
          }
          return
        } catch (e: any) {
          output.output = `[EG:ERROR ${e.message}]`
          return
        }
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
        output.output = `[EG:edit] wrote ${path} as ${origEncoding}`
      }
    },
  }
}
