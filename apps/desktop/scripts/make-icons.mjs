// 生成灵动岛图标（PNG + 多尺寸 ICO），零依赖：自己画像素 + 自己编码 PNG/ICO。
//   node scripts/make-icons.mjs
// 产出：assets/icon.png(256) assets/icon.ico(16/24/32/48/64/128/256) assets/tray.png(32)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'assets')
fs.mkdirSync(outDir, { recursive: true })

const SS = 4 // 超采样倍数，边缘才干净

/** 圆角矩形覆盖判定。 */
function insideRoundRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function mix(a, b, t) { return a + (b - a) * t }

/**
 * 画一张 size×size 的 RGBA 图：
 * 蓝色渐变圆角方块（灵动的岛）+ 中间一条白色胶囊（小岛本体）+ 胶囊里一个小圆点。
 */
function render(size) {
  const big = size * SS
  const pixels = new Float32Array(big * big * 4)

  const radius = big * 0.235
  const pillLeft = big * 0.2
  const pillRight = big * 0.8
  const pillTop = big * 0.38
  const pillBottom = big * 0.62
  const pillRadius = (pillBottom - pillTop) / 2
  const dotRadius = (pillBottom - pillTop) * 0.26
  const dotX = mix(pillLeft, pillRight, 0.24)
  const dotY = (pillTop + pillBottom) / 2

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const index = (y * big + x) * 4
      // 底色：蓝色→紫色竖向渐变（和插件的品牌色一致）
      const t = y / (big - 1)
      let r = mix(0x4f, 0x7c, t)
      let g = mix(0x8c, 0x5c, t)
      let b = mix(0xff, 0xff, t)
      let a = 0

      if (insideRoundRect(x + 0.5, y + 0.5, 0, 0, big - 1, big - 1, radius)) {
        a = 255
        // 左上角一点高光，小尺寸下更像"有厚度"
        const shine = Math.max(0, 1 - Math.hypot(x - big * 0.3, y - big * 0.24) / (big * 0.5))
        r = Math.min(255, r + shine * 26)
        g = Math.min(255, g + shine * 26)
        b = Math.min(255, b + shine * 20)
      }

      if (a > 0 && insideRoundRect(x + 0.5, y + 0.5, pillLeft, pillTop, pillRight, pillBottom, pillRadius)) {
        r = 245; g = 247; b = 255; a = 255
        // 胶囊里的小圆点：深色，像岛里有个内容
        if (Math.hypot(x + 0.5 - dotX, y + 0.5 - dotY) <= dotRadius) { r = 0x12; g = 0x16; b = 0x22 }
      }

      pixels[index] = r
      pixels[index + 1] = g
      pixels[index + 2] = b
      pixels[index + 3] = a
    }
  }

  // 盒式降采样回目标尺寸（超采样抗锯齿）
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const index = (((y * SS + sy) * big) + (x * SS + sx)) * 4
          const alpha = pixels[index + 3] / 255
          r += pixels[index] * alpha
          g += pixels[index + 1] * alpha
          b += pixels[index + 2] * alpha
          a += pixels[index + 3]
        }
      }
      const count = SS * SS
      const alpha = a / count
      const weight = alpha > 0 ? a / 255 : 1
      const at = (y * size + x) * 4
      out[at] = Math.round(r / weight)
      out[at + 1] = Math.round(g / weight)
      out[at + 2] = Math.round(b / weight)
      out[at + 3] = Math.round(alpha)
    }
  }
  return out
}

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0  // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- ICO 封装（内嵌 PNG，Vista+）
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)          // type: icon
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + directory.length
  entries.forEach((entry, index) => {
    const at = index * 16
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4)     // color planes
    directory.writeUInt16LE(32, at + 6)    // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, directory, ...entries.map(entry => entry.png)])
}

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const pngs = new Map(SIZES.map(size => [size, encodePng(size, render(size))]))

fs.writeFileSync(path.join(outDir, 'icon.png'), pngs.get(256))
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(SIZES.map(size => ({ size, png: pngs.get(size) }))))
fs.writeFileSync(path.join(outDir, 'tray.png'), pngs.get(32))
// 托盘在高分屏下会挑更大的图，顺手给一张 2x
fs.writeFileSync(path.join(outDir, 'tray@2x.png'), pngs.get(64))

console.log('已生成:')
for (const name of ['icon.png', 'icon.ico', 'tray.png', 'tray@2x.png']) {
  const file = path.join(outDir, name)
  console.log(`  ${name}  ${fs.statSync(file).size} bytes`)
}
