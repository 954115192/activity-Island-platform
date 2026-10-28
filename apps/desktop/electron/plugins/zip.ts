/**
 * 零依赖的 zip 读写。
 *
 * 为什么不用 PowerShell 的 Compress-Archive / Expand-Archive：
 * 实测同一台机器上、同一条命令，它会随调用形态与目标扩展名给出不一致的结果 ——
 * 打包 `.islandplugin` 时从 Node 调用是 exit 0，从另一个 PowerShell 里调用却报
 * "`.islandplugin` is not a supported archive file format"；目标没有扩展名时更是
 * **exit 0 但一个文件都没生成**。而且它的 stderr 很容易被吞掉，用户只看到一个
 * 没有信息量的 "exit 1"，既没法自愈也没法排查。
 *
 * 自己实现之后：不依赖外部程序与执行策略、扩展名随便起、错误信息精确可控。
 * 格式只需覆盖自己写自己读，同时**能读别人用 Compress-Archive 打出来的包**。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------- 写

export interface ZipWriteOptions {
  /** 返回 true 表示这个目录整棵跳过。 */
  skipDir?: (name: string) => boolean
  /** 返回 true 表示这个文件跳过。 */
  skipFile?: (name: string) => boolean
  /** 压缩级别，默认 9。 */
  level?: number
}

interface PendingEntry {
  name: string
  crc: number
  compressed: Buffer
  size: number
  offset: number
}

function collectFiles(root: string, options: ZipWriteOptions, prefix = ''): Array<{ name: string; absolute: string }> {
  const files: Array<{ name: string; absolute: string }> = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (options.skipDir?.(entry.name)) continue
    if (entry.isDirectory()) {
      files.push(...collectFiles(path.join(root, entry.name), options, `${prefix}${entry.name}/`))
      continue
    }
    if (!entry.isFile()) continue
    if (options.skipFile?.(entry.name)) continue
    files.push({ name: `${prefix}${entry.name}`, absolute: path.join(root, entry.name) })
  }
  return files
}

/** DOS 时间格式（zip 只用得到秒级 + 2 秒精度）。 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * 把一个目录写成一个 zip 文件（条目名用 `/` 分隔、UTF-8 编码）。
 * 条目都在压缩包的根下（不套一层目录名），和以前的 .islandplugin 保持一致。
 */
export function zipDirectory(sourceDir: string, outFile: string, options: ZipWriteOptions = {}): number {
  const level = options.level ?? 9
  const files = collectFiles(sourceDir, options)
  if (!files.length) throw new Error('目录里没有可打包的文件')
  const { time, date } = dosDateTime(new Date())
  const chunks: Buffer[] = []
  const entries: PendingEntry[] = []
  let offset = 0

  for (const file of files) {
    const data = fs.readFileSync(file.absolute)
    const crc = crc32(data)
    const compressed = zlib.deflateRawSync(data, { level })
    const nameBuffer = Buffer.from(file.name, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)             // version needed
    header.writeUInt16LE(0x0800, 6)         // UTF-8 名字
    header.writeUInt16LE(8, 8)              // deflate
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBuffer.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, nameBuffer, compressed)
    entries.push({ name: file.name, crc, compressed, size: data.length, offset })
    offset += header.length + nameBuffer.length + compressed.length
  }

  const centralStart = offset
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)             // version made by
    record.writeUInt16LE(20, 6)             // version needed
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(entry.crc, 16)
    record.writeUInt32LE(entry.compressed.length, 20)
    record.writeUInt32LE(entry.size, 24)
    record.writeUInt16LE(nameBuffer.length, 28)
    record.writeUInt16LE(0, 30)             // extra
    record.writeUInt16LE(0, 32)             // comment
    record.writeUInt16LE(0, 34)             // disk
    record.writeUInt16LE(0, 36)             // internal attrs
    record.writeUInt32LE(0, 38)             // external attrs
    record.writeUInt32LE(entry.offset, 42)
    chunks.push(record, nameBuffer)
    offset += record.length + nameBuffer.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  chunks.push(end)

  const output = Buffer.concat(chunks)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, output)
  return output.length
}

// ---------------------------------------------------------------- 读

export interface ZipReadEntry { name: string; data: Buffer }

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 66000)
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index
  }
  throw new Error('不是有效的 zip 包（找不到目录结尾）')
}

/**
 * 读出 zip 内的全部条目。
 * 尺寸与偏移一律以**中央目录**为准：Compress-Archive 会设置"数据描述符"标志位，
 * 那种包在局部头里尺寸是 0，只有中央目录是对的。
 */
export function readZipEntries(file: string): ZipReadEntry[] {
  const buffer = fs.readFileSync(file)
  const end = findEndOfCentralDirectory(buffer)
  const total = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  const entries: ZipReadEntry[] = []
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('zip 中央目录已损坏')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue // 目录条目
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip 条目损坏：${name}`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) entries.push({ name, data: Buffer.from(raw) })
    else if (method === 8) entries.push({ name, data: zlib.inflateRawSync(raw) })
    else throw new Error(`不支持的压缩方式（method ${method}）：${name}`)
  }
  return entries
}

/** 是否为 zip 包（只看魔数，用来给出"这文件不是插件包"这种可读错误）。 */
export function isZipFile(file: string): boolean {
  try {
    const handle = fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(4)
      fs.readSync(handle, head, 0, 4, 0)
      return head.readUInt32LE(0) === 0x04034b50 || head.readUInt32LE(0) === 0x06054b50
    } finally { fs.closeSync(handle) }
  } catch { return false }
}

/**
 * 解压到目标目录，返回写出的相对路径列表。
 * 条目名一律做路径穿越检查：包是可以从别处拿到的，不能让 `../` 写到目录外面。
 */
export function extractZip(file: string, targetDir: string): string[] {
  const root = path.resolve(targetDir)
  const written: string[] = []
  for (const entry of readZipEntries(file)) {
    const normalized = entry.name.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) continue
    const destination = path.resolve(root, normalized)
    if (destination !== root && !destination.startsWith(root + path.sep)) continue
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, entry.data)
    written.push(normalized)
  }
  return written
}
