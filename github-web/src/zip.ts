/**
 * 最小 zip 写入器（零依赖）。
 *
 * ## 为什么自己写
 *
 * 「下载整门课」需要把几十个文件打成一个包。可选方案都更差：
 *   · 逐个文件下载 → 几十次浏览器下载提示，不可用
 *   · GitHub 的 zipball API → 只能给**整个仓库**（16 门课），而且 `api.github.com` 在国内网络
 *     经常不可达 / 限流——那正是这个站点做成双托管模式要绕开的失败模式
 *   · 引一个 zip 库 → 仓库纪律是能不加依赖就不加（用户要求遵循马尾辫）
 *
 * zip 容器本身并不复杂：local file header + 数据 + central directory + EOCD，
 * 压缩交给浏览器原生的 `CompressionStream('deflate-raw')`。
 *
 * ## 两个容易写错、且写错了不报错的地方
 *
 * 1. **通用位标记 bit 11（0x0800）必须置位**，声明条目名是 UTF-8（zip 规范的做法）。
 *    不置位时，**较老的解压器**（旧版资源管理器、部分第三方工具）会按 CP437 解读中文文件名，
 *    解压出来是乱码，而 zip 本身照样能解开、不报错。
 *    注意：现代 Windows 的 `Expand-Archive` 即使没有这一位也能正确解码，
 *    所以**行为测试观察不到这个缺陷**——`scripts/check-zip.mjs` 改为直接断言产物里的这一位。
 * 2. **CRC32 是必需的**，即使某些解压器宽容，规范的解压器会拒绝。
 *
 * ## 兼容性
 *
 * `CompressionStream('deflate-raw')` 在 Chrome 80+ / Safari 16.4+ 有。
 * 不支持时**退回 STORE（不压缩）**——包大一些，功能不变，而不是整个功能不可用。
 */

/** 一个待打包的条目 */
export type ZipEntry = {
  /** 归档内的路径，用 `/` 分隔（zip 规范要求，与操作系统无关） */
  name: string
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS 时间/日期（zip 用的老格式：秒只有 2 秒精度） */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const d = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: d }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return undefined // 引擎不认 deflate-raw：退回 STORE
  }
}

const encoder = new TextEncoder()

/** 小端写入 */
class Writer {
  private chunks: Uint8Array[] = []
  length = 0

  bytes(b: Uint8Array): void {
    this.chunks.push(b)
    this.length += b.length
  }

  u16(v: number): void {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]))
  }

  u32(v: number): void {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]))
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}

/** 把若干条目打成一个 zip。返回可直接给 Blob 的字节 */
export async function buildZip(entries: ZipEntry[], date = new Date()): Promise<Uint8Array> {
  const { time, date: dosDate } = dosDateTime(date)
  const body = new Writer()
  const central = new Writer()

  // 并发压缩所有条目：利用多核并行，避免 100+ 条目在单线程中逐个串行等待 CompressionStream
  const prepared = await Promise.all(
    entries.map(async (entry) => {
      const name = encoder.encode(entry.name)
      const crc = crc32(entry.data)
      const deflated = await deflateRaw(entry.data)
      // 压不小就别压（小文件与已压缩内容压缩后反而更大）
      const useDeflate = deflated !== undefined && deflated.length < entry.data.length
      const payload = useDeflate ? deflated : entry.data
      const method = useDeflate ? 8 : 0
      return { entry, name, crc, payload, method }
    }),
  )

  for (const { entry, name, crc, payload, method } of prepared) {
    const offset = body.length

    // local file header
    body.u32(0x04034b50)
    body.u16(20) // version needed（2.0：支持 deflate）
    body.u16(0x0800) // ← 通用位标记：bit 11 = 文件名是 UTF-8。不置位中文名会变乱码
    body.u16(method)
    body.u16(time)
    body.u16(dosDate)
    body.u32(crc)
    body.u32(payload.length)
    body.u32(entry.data.length)
    body.u16(name.length)
    body.u16(0) // extra field length
    body.bytes(name)
    body.bytes(payload)

    // central directory file header
    central.u32(0x02014b50)
    central.u16(20) // version made by
    central.u16(20) // version needed
    central.u16(0x0800)
    central.u16(method)
    central.u16(time)
    central.u16(dosDate)
    central.u32(crc)
    central.u32(payload.length)
    central.u32(entry.data.length)
    central.u16(name.length)
    central.u16(0) // extra
    central.u16(0) // comment
    central.u16(0) // disk number start
    central.u16(0) // internal attrs
    central.u32(0) // external attrs
    central.u32(offset)
    central.bytes(name)
  }

  const centralBytes = central.concat()
  const eocd = new Writer()
  eocd.u32(0x06054b50)
  eocd.u16(0) // this disk
  eocd.u16(0) // disk with central dir
  eocd.u16(entries.length)
  eocd.u16(entries.length)
  eocd.u32(centralBytes.length)
  eocd.u32(body.length)
  eocd.u16(0) // comment length

  const out = new Uint8Array(body.length + centralBytes.length + eocd.length)
  out.set(body.concat(), 0)
  out.set(centralBytes, body.length)
  out.set(eocd.concat(), body.length + centralBytes.length)
  return out
}
