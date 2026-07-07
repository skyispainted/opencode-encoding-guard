import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

const MAX_DETECT_SIZE = 1 * 1024 * 1024
const RULES_FILE = ".encoding-rules"

interface CacheEntry {
  encoding: string
  mtimeMs: number
}

interface Rule {
  pattern: string
  encoding: string
  negated: boolean
}

const encodingCache = new Map<string, CacheEntry>()
let rules: Rule[] = []
let rulesLoaded = false

// --- .encoding-rules loader ---

function globToRegex(pattern: string): RegExp {
  const STAR_PLACEHOLDER = "__GLOBSTAR__"
  let regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  // ** matches any path (including /)
  regex = regex.replace(/\*\*/g, STAR_PLACEHOLDER)
  // * matches any char except /
  regex = regex.replace(/\*/g, "[^/]*")
  // ? matches single char except /
  regex = regex.replace(/\?/g, "[^/]")
  // restore **
  regex = regex.replace(new RegExp(STAR_PLACEHOLDER, "g"), ".*")
  return new RegExp(`^${regex}$`)
}

function matchRule(filePath: string): string {
  if (!rules.length) return "utf8"
  // Normalize path separators for matching
  const normalized = filePath.replace(/\\/g, "/")
  const basename = normalized.split("/").pop() || ""
  let result = "utf8"

  for (const rule of rules) {
    if (rule.negated) {
      const re = globToRegex(rule.pattern)
      if (re.test(normalized) || re.test(basename)) {
        result = "utf8" // negation resets to default
      }
    } else {
      const re = globToRegex(rule.pattern)
      if (re.test(normalized) || re.test(basename)) {
        result = rule.encoding
      }
    }
  }
  return result
}

async function loadRules(projectRoot: string): Promise<void> {
  const rulesPath = join(projectRoot, RULES_FILE)
  if (!existsSync(rulesPath)) {
    rules = []
    rulesLoaded = true
    return
  }
  const content = await readFile(rulesPath, "utf-8")
  rules = content
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => {
      const spaceIdx = line.indexOf(" ")
      if (spaceIdx === -1) return null
      const pattern = line.slice(0, spaceIdx)
      const encoding = line.slice(spaceIdx + 1).trim().toLowerCase()
      const negated = pattern.startsWith("!")
      return { pattern: negated ? pattern.slice(1) : pattern, encoding, negated }
    })
    .filter(Boolean) as Rule[]
  rulesLoaded = true
}

// --- encoding decoding ---

async function decodeByRule(path: string, encoding: string): Promise<string | null> {
  try {
    const buffer = await readFile(path)
    const upper = encoding.toUpperCase()
    if (upper === "UTF8" || upper === "UTF-8") {
      return new TextDecoder("utf-8", { fatal: false }).decode(buffer)
    }
    // Node.js TextDecoder supports: gbk, gb2312, shift_jis, euc-kr, etc.
    return new TextDecoder(upper, { fatal: false }).decode(buffer)
  } catch {
    return null
  }
}

async function detectAndDecode(path: string, projectRoot: string): Promise<{ encoding: string; text?: string }> {
  const s = await stat(path)
  const cached = encodingCache.get(path)
  if (cached && cached.mtimeMs === s.mtimeMs) {
    if (cached.encoding === "utf8") return { encoding: "utf8" }
  }

  if (!rulesLoaded) await loadRules(projectRoot)
  const encoding = matchRule(path)

  if (encoding === "utf8") {
    encodingCache.set(path, { encoding: "utf8", mtimeMs: s.mtimeMs })
    return { encoding: "utf8" }
  }

  const decoded = await decodeByRule(path, encoding)
  if (!decoded) {
    encodingCache.set(path, { encoding: "utf8", mtimeMs: s.mtimeMs })
    return { encoding: "utf8" }
  }
  encodingCache.set(path, { encoding, mtimeMs: s.mtimeMs })
  return { encoding, text: decoded }
}

function countFffd(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "�") n++
  }
  return n
}

// --- plugin ---

function findProjectRoot(): string {
  return process.cwd()
}

export const EncodingGuard: Plugin = async () => {
  encodingCache.clear()
  rulesLoaded = false
  const projectRoot = findProjectRoot()
  await loadRules(projectRoot)

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (input.tool !== "edit") return
      const path = output.args?.filePath
      if (!path || !existsSync(path)) return
      try {
        const s = await stat(path)
        if (s.size > MAX_DETECT_SIZE || s.size === 0) return
        const result = await detectAndDecode(path, projectRoot)
        if (result.encoding === "utf8" || !result.text) return
        const normalized = result.text.replace(/\r\n/g, "\n")
        await writeFile(path, normalized, "utf-8")
        encodingCache.set(path, { encoding: "utf8", mtimeMs: Date.now() })
      } catch {}
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool !== "read") return
      if (!output.output || !input.args?.filePath) return
      const content: string = output.output
      if (!content.includes("�")) return
      const fffdCount = countFffd(content.slice(0, 2000))
      if (fffdCount < 5) return
      const path = input.args.filePath
      if (!existsSync(path)) return
      try {
        const s = await stat(path)
        if (s.size > MAX_DETECT_SIZE || s.size === 0) return
        const result = await detectAndDecode(path, projectRoot)
        if (result.encoding === "utf8" || !result.text) return
        const lines = result.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
        const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n")
        output.output =
          `<path>${path}</path>\n` +
          `<type>file</type>\n` +
          `<content>\n${numbered}\n\n(End of file - total ${lines.length} lines)\n</content>`
      } catch {}
    },
  }
}
