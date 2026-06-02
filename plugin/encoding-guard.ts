import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"

const MAX_DETECT_SIZE = 1 * 1024 * 1024

interface CacheEntry {
  encoding: "utf8" | "gbk"
  mtimeMs: number
}

const encodingCache = new Map<string, CacheEntry>()

function detectGbk(buffer: Buffer): string | null {
  // First-line heuristic: if the first \n-delimited line after UTF-8 decode
  // contains U+FFFD, the file's header is not valid UTF-8 → likely GBK.
  // This avoids dilution by long ASCII tails (e.g. 500KB log with GBK header).
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer)
  const nl = utf8.indexOf("\n")
  const header = nl > 0 ? utf8.slice(0, nl) : utf8.slice(0, 200)
  if (!header.includes("\uFFFD")) return null
  try {
    return new TextDecoder("GBK").decode(buffer)
  } catch {
    return null
  }
}

async function detectAndDecode(path: string): Promise<{ encoding: "utf8" | "gbk"; text?: string }> {
  const s = await stat(path)
  const cached = encodingCache.get(path)
  if (cached && cached.mtimeMs === s.mtimeMs) {
    // Cache hit: if previously detected as UTF-8, skip read entirely.
    // If previously GBK, still need to read to get decoded text for this call.
    if (cached.encoding === "utf8") return { encoding: "utf8" }
  }
  const buffer = await readFile(path)
  const decoded = detectGbk(buffer)
  if (decoded) {
    encodingCache.set(path, { encoding: "gbk", mtimeMs: s.mtimeMs })
    return { encoding: "gbk", text: decoded }
  }
  encodingCache.set(path, { encoding: "utf8", mtimeMs: s.mtimeMs })
  return { encoding: "utf8" }
}

function countFffd(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\uFFFD") n++
  }
  return n
}

export const EncodingGuard: Plugin = async () => {
  encodingCache.clear()

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (input.tool !== "edit") return
      const path = output.args?.filePath
      if (!path || !existsSync(path)) return
      try {
        const s = await stat(path)
        if (s.size > MAX_DETECT_SIZE || s.size === 0) return
        const result = await detectAndDecode(path)
        if (result.encoding !== "gbk" || !result.text) return
        const normalized = result.text.replace(/\r\n/g, "\n")
        await writeFile(path, normalized, "utf-8")
        encodingCache.set(path, { encoding: "utf8", mtimeMs: Date.now() })
      } catch {}
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool !== "read") return
      if (!output.output || !input.args?.filePath) return
      const content: string = output.output
      if (!content.includes("\uFFFD")) return
      const fffdCount = countFffd(content.slice(0, 2000))
      if (fffdCount < 5) return
      const path = input.args.filePath
      if (!existsSync(path)) return
      try {
        const s = await stat(path)
        if (s.size > MAX_DETECT_SIZE || s.size === 0) return
        const result = await detectAndDecode(path)
        if (result.encoding !== "gbk" || !result.text) return
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
