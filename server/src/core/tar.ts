import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

/**
 * Minimal POSIX ustar reader/writer.
 *
 * A cluster backup is several `pg_dump` archives plus a globals script that
 * must travel as one file. Tar is the obvious container, and the ustar subset
 * needed here is small enough to implement outright — which keeps the project's
 * zero-native-dependency property, behaves identically on every platform, and
 * is exhaustively testable without shelling out to a `tar` binary.
 *
 * No compression: `pg_dump --format=custom` output is already compressed, so
 * wrapping it again costs CPU and saves almost nothing.
 */

const BLOCK = 512
/** ustar `name` field. Longer paths need the prefix field, which we avoid. */
const MAX_NAME = 99

export interface TarEntry {
  name: string
  size: number
  /** Byte offset of the entry's content within the archive. */
  offset: number
}

function octal(value: number, width: number): string {
  // width includes the trailing NUL that terminates the field.
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function header(name: string, size: number, mtime: Date): Buffer {
  if (Buffer.byteLength(name) > MAX_NAME) {
    throw new Error(`Archive entry name too long for ustar: ${name}`)
  }
  const buf = Buffer.alloc(BLOCK)
  buf.write(name, 0, 100, 'utf8')
  buf.write(octal(0o644, 8), 100, 8)
  buf.write(octal(0, 8), 108, 8) // uid
  buf.write(octal(0, 8), 116, 8) // gid
  buf.write(octal(size, 12), 124, 12)
  buf.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12)
  buf.write('        ', 148, 8) // checksum placeholder: spaces
  buf.write('0', 156, 1) // typeflag: regular file
  buf.write('ustar\0', 257, 6)
  buf.write('00', 263, 2)

  let sum = 0
  for (const byte of buf) sum += byte
  // Historic quirk: six octal digits, NUL, then a space.
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return buf
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK

/**
 * Streams `files` into one archive. Each source is read in chunks, so a
 * multi-gigabyte dump never sits in memory.
 */
export async function packTar(
  target: string,
  files: { name: string; path: string }[],
): Promise<void> {
  const out = createWriteStream(target)
  const write = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      out.write(chunk, (err) => (err ? reject(err) : resolve()))
    })

  try {
    for (const file of files) {
      const info = await stat(file.path)
      await write(header(file.name, info.size, info.mtime))
      await pipeline(createReadStream(file.path), out, { end: false })
      const pad = padding(info.size)
      if (pad > 0) await write(Buffer.alloc(pad))
    }
    // Two zero blocks mark the end of the archive.
    await write(Buffer.alloc(BLOCK * 2))
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
}

function parseOctal(buf: Buffer): number {
  const text = buf.toString('latin1').replace(/\0.*$/, '').trim()
  if (text.length === 0) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * Reads the entry table without loading any content. Directory entries and
 * other non-regular types are skipped — this archive only ever holds files.
 */
export async function listTar(archive: string): Promise<TarEntry[]> {
  const handle = await open(archive, 'r')
  try {
    const entries: TarEntry[] = []
    const block = Buffer.alloc(BLOCK)
    let offset = 0
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, BLOCK, offset)
      if (bytesRead < BLOCK) break
      // A zero block ends the archive.
      if (block.every((byte) => byte === 0)) break

      const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
      const size = parseOctal(block.subarray(124, 136))
      const typeflag = block.subarray(156, 157).toString('latin1')
      const contentAt = offset + BLOCK

      if (name.length > 0 && (typeflag === '0' || typeflag === '\0')) {
        entries.push({ name, size, offset: contentAt })
      }
      offset = contentAt + size + padding(size)
    }
    return entries
  } finally {
    await handle.close()
  }
}

/** Extracts one entry to `target`, streaming so large dumps stay off the heap. */
export async function extractEntry(
  archive: string,
  entry: TarEntry,
  target: string,
): Promise<void> {
  if (entry.size === 0) {
    // `end` is inclusive, so a zero-length range would still read one byte.
    await new Promise<void>((resolve, reject) => {
      createWriteStream(target).end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
    return
  }
  await pipeline(
    createReadStream(archive, { start: entry.offset, end: entry.offset + entry.size - 1 }),
    createWriteStream(target),
  )
}

/** Small entries only — the manifest. Anything large should be extracted. */
export async function readEntry(archive: string, entry: TarEntry): Promise<Buffer> {
  const handle = await open(archive, 'r')
  try {
    const buf = Buffer.alloc(entry.size)
    if (entry.size > 0) await handle.read(buf, 0, entry.size, entry.offset)
    return buf
  } finally {
    await handle.close()
  }
}
