/**
 * Read the last N lines of a file efficiently (from the end).
 *
 * Chunks stay as raw bytes and are decoded once, at the very end. Decoding each
 * 64 KiB chunk on its own would split any multi-byte UTF-8 sequence that
 * straddles a chunk boundary and turn it into two replacement characters.
 */
import { promises as fs } from 'fs'
import { StringDecoder } from 'string_decoder'

export async function tailFile(filePath: string, maxLines: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof fs.open>>
  try {
    fh = await fs.open(filePath, 'r')
  } catch {
    return '(no log)'
  }
  try {
    const stat = await fh.stat()
    if (stat.size === 0) return '(empty)'
    const CHUNK = 64 * 1024
    let pos = stat.size
    const chunks: Buffer[] = []
    let lineCount = 0
    while (pos > 0 && lineCount <= maxLines) {
      const size = Math.min(CHUNK, pos)
      pos -= size
      const buf = Buffer.alloc(size)
      const { bytesRead } = await fh.read(buf, 0, size, pos)
      const chunk = buf.subarray(0, bytesRead)
      // 0x0A never occurs inside a multi-byte UTF-8 sequence, so counting
      // newlines on the raw bytes is safe and avoids a decode per chunk.
      for (const byte of chunk) if (byte === 0x0a) lineCount++
      chunks.unshift(chunk)
    }
    const decoder = new StringDecoder('utf8')
    let all = ''
    for (const chunk of chunks) all += decoder.write(chunk)
    all += decoder.end()
    const lines = all.split('\n')
    return lines.slice(-maxLines).join('\n').replace(/^\n+/, '') || '(empty)'
  } finally {
    await fh.close()
  }
}
