/**
 * 生成应用图标源图（1024×1024 PNG），免去往仓库里塞一个来路不明的二进制。
 *
 * 然后跑 `pnpm --filter @app/desktop tauri icon scripts/icon-source.png`
 * 让 Tauri 派生出各尺寸与 .ico。
 *
 * 手写 PNG 编码器（zlib 来自 Node 内置）而不是引依赖：一次性用途，几十行足够。
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 1024
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'icon-source.png')

// 配色与 M0 冒烟页一致：off-black 底 + 青绿强调色（不用纯黑，见 docs/03 §8.2）
const BG = [24, 24, 27, 255]
const INK = [45, 212, 191, 255]
const DIM = [82, 82, 91, 255]

const px = Buffer.alloc(SIZE * SIZE * 4)

/** 把 [x0,x1) × [y0,y1) 区域填色（带圆角处理留给 derive 后的尺寸） */
function rect(x0, y0, x1, y1, [r, g, b, a]) {
  for (let y = Math.max(0, y0); y < Math.min(SIZE, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(SIZE, x1); x++) {
      const i = (y * SIZE + x) * 4
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = a
    }
  }
}

// 底
rect(0, 0, SIZE, SIZE, BG)

// 一个"文档 + 强调行"的极简标记：左边一条竖线（书脊），右边几行"文字"
const PAD = 180
const SPINE_W = 56
rect(PAD, PAD, PAD + SPINE_W, SIZE - PAD, INK)

const lineX0 = PAD + SPINE_W + 110
const lineX1 = SIZE - PAD
const ROW_H = 52
for (let i = 0; i < 7; i++) {
  const y = PAD + 40 + i * (ROW_H + 46)
  // 第 3 行用强调色，其余用中性灰——表示"这一段被引用"
  const color = i === 2 ? INK : DIM
  const w = i === 2 ? lineX1 : lineX0 + Math.round((lineX1 - lineX0) * (i % 3 === 0 ? 0.72 : 1))
  rect(lineX0, y, w, y + ROW_H, color)
}

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

// 每行前置一个 filter 字节（0 = None）
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

writeFileSync(OUT, png)
console.log(`wrote ${OUT} (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`)
