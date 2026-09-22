/**
 * zip 写入器的可运行检查。
 *
 * 这是本次改动里**唯一"写错也不报错"**的地方：
 *   · 不置 UTF-8 位标记时，中文文件名会按 CP437 被解读成乱码——而 zip 本身照样能解开
 *   · CRC32 写错时，宽容的解压器（含部分图形工具）会直接忽略，只有严格的解压器才拒绝
 * 所以不能"自己验自己"（用同一套代码读回自己的产物）。这里**让操作系统来验**：
 * 用 Windows 自带的 `Expand-Archive` 解压，再逐字节比对内容与文件名。
 *
 *   node scripts/check-zip.mjs
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const { buildZip } = await import('../github-web/src/zip.ts')

let failed = 0
const check = (ok, label, detail = '') => {
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed += 1
}

const enc = new TextEncoder()

/** 用例刻意包含：中文名、嵌套目录、前缀相同的名字、空文件、大文件（跨 deflate 块）、重复内容 */
const CASES = [
  { name: '黑马程序员-Python-AI/textbooks/模块01_Python 与 AI 时代导学_精读全书.md', text: '# 标题\n\n正文含公式 $E=mc^2$ 与代码。\n' },
  { name: '黑马程序员-Python-AI/notes/笔记01_知识体系_笔记.md', text: '复习笔记\n' },
  { name: '黑马程序员-Python-AI/subtitles/P01_01. Python+AI课程导学_clean.txt', text: '逐字稿内容\n'.repeat(50) },
  { name: '空文件.txt', text: '' },
  { name: '重复内容/a.md', text: 'ab'.repeat(5000) }, // 高度可压缩：走 deflate 分支
  { name: '不可压缩.bin', text: Array.from({ length: 3000 }, (_, i) => String.fromCharCode(i % 256)).join('') },
]

const work = mkdtempSync(join(tmpdir(), 'zipcheck-'))
const zipPath = join(work, 'test.zip')
const outDir = join(work, 'out')

try {
  const zip = await buildZip(
    CASES.map((c) => ({ name: c.name, data: enc.encode(c.text) })),
    new Date(2026, 0, 2, 3, 4, 6),
  )
  writeFileSync(zipPath, zip)
  console.log(`══ 生成 test.zip：${(zip.length / 1024).toFixed(1)} KB（原内容 ${(CASES.reduce((n, c) => n + enc.encode(c.text).length, 0) / 1024).toFixed(1)} KB）`)

  console.log('\n══ 用 Windows 自带的 Expand-Archive 解压（让操作系统验，不是自己验自己）')
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
      { stdio: 'pipe' },
    )
    check(true, 'Expand-Archive 解压成功（CRC 与容器结构被 Windows 接受）')
  } catch (e) {
    check(false, 'Expand-Archive 解压成功', String(e.stderr ?? e).slice(0, 300))
  }

  console.log('\n══ 直接断言产物结构（行为测试抓不到的那一位）')
  // 负向测试证明过：去掉 UTF-8 位标记后，下面的 Expand-Archive 比对**仍然全部通过**——
  // 现代 Windows 反正能解码 UTF-8。所以那一条对这个缺陷没有牙齿，必须直接读产物里的位。
  const raw = readFileSync(zipPath)
  const flagOf = (offset) => raw.readUInt16LE(offset + 6) // local file header: 签名(4) 版本(2) 标记(2)
  check(raw.readUInt32LE(0) === 0x04034b50, '首部是 local file header 签名')
  check((flagOf(0) & 0x800) !== 0, '通用位标记 bit 11（UTF-8 文件名）已置位', `flags=0x${flagOf(0).toString(16).padStart(4, '0')}`)

  console.log('\n══ 逐文件比对')
  const found = []
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else found.push(relative(outDir, p).split(sep).join('/'))
    }
  }
  walk(outDir)

  check(found.length === CASES.length, `条目数 = ${CASES.length}`, `实际 ${found.length}`)

  const missing = CASES.filter((c) => !found.includes(c.name)).map((c) => c.name)
  // 注意：这条通过**不能**证明 UTF-8 位标记写对了——现代 Windows 无论如何都能解码 UTF-8，
  // 真正管那件事的是上面的「通用位标记 bit 11」断言。
  check(missing.length === 0, '中文文件名逐个原样还原', missing.length ? `缺失：${missing.join(', ')}` : `${CASES.length} 个名字全中`)

  const mismatched = []
  for (const c of CASES) {
    if (!found.includes(c.name)) continue
    const got = readFileSync(join(outDir, ...c.name.split('/')), 'utf8')
    if (got !== c.text) mismatched.push(c.name)
  }
  check(mismatched.length === 0, '每个文件内容逐字节一致', mismatched.length ? `不一致：${mismatched.join(', ')}` : '')
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '通过：zip 写入器产出的是合法且文件名正确的归档。' : `有 ${failed} 项未通过。`}`)
process.exitCode = failed === 0 ? 0 : 1
