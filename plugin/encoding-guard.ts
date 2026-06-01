import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs"

const MAX_DETECT_SIZE = 1 * 1024 * 1024
const UFFFD_THRESHOLD = 0.5
const correctedMap = new Map<string, string>()

function detectGbk(buffer: Buffer): string | null {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer)
  const total = utf8.length
  if (total === 0) return null
  let fffdCount = 0
  for (let i = 0; i < total; i++) {
    if (utf8[i] === "\uFFFD") fffdCount++
  }
  if (fffdCount / total < UFFFD_THRESHOLD) return null
  try {
    return new TextDecoder("GBK").decode(buffer)
  } catch {
    return null
  }
}

function convertFileToUtf8(path: string): void {
  try {
    const buffer = readFileSync(path)
    const stat = statSync(path)
    if (stat.size > MAX_DETECT_SIZE || stat.size === 0) return
    const decoded = detectGbk(buffer)
    if (decoded === null) return
    const normalized = decoded.replace(/\r\n/g, "\n")
    writeFileSync(path, normalized, "utf-8")
  } catch {}
}

export const EncodingGuard: Plugin = async () => {
  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (input.tool === "read" && input.callID) {
        const path = output.args?.filePath
        if (path && existsSync(path)) {
          try {
            if (statSync(path).size > MAX_DETECT_SIZE || statSync(path).size === 0) return
          } catch { return }
          const buffer = readFileSync(path)
          const decoded = detectGbk(buffer)
          if (decoded === null) return
          const lines = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
          const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n")
          const wrapped =
            `<path>${path}</path>\n` +
            `<type>file</type>\n` +
            `<content>\n${numbered}\n\n(End of file - total ${lines.length} lines)\n</content>`
          correctedMap.set(input.callID, wrapped)
        }
      }

      // B 类：edit 前将 GBK 文件一次性转为 UTF-8
      if (input.tool === "edit" && output.args?.filePath) {
        convertFileToUtf8(output.args.filePath)
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool === "read" && input.callID) {
        const fixed = correctedMap.get(input.callID)
        if (fixed) {
          output.output = fixed
          correctedMap.delete(input.callID)
        }
      }
    },
  }
}
