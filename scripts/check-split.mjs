/**
 * 章节拆分的可运行检查。
 *
 * 为什么需要它：章序号（chapterIndex）一旦偏移会**静默污染**线程绑定、进度、read_chapter、
 * 划词引用——不报错，只是错位。而全库有 158 册两套排版批次、标题带不可见字符差异，
 * 靠人抽查是查不干净的。这个脚本把全库跑一遍，把「导读条目数 ≠ 实际章数」这类问题抖出来。
 *
 *   node scripts/check-split.mjs [课程仓或本地 clone 目录]
 *
 * 默认取本地 clone；没有 clone 时提示先 clone 或指定目录。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const { splitDocument } = await import('../packages/reader/src/model/split-document.ts')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIR = 'D:/project/项目/笔记sikll/课程'
const dir = process.argv[2] ?? process.env.COURSES_DIR ?? DEFAULT_DIR

if (!existsSync(dir)) {
  console.error(`找不到课程目录：${dir}`)
  console.error('用法：node scripts/check-split.mjs <课程仓或本地 clone 目录>')
  process.exit(2)
}

/** 收集所有分类目录下的 textbooks/*.md 与 notes/*.md */
function collectDocuments(root) {
  const out = []
  const walk = (dir, parts = []) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path, [...parts, entry])
        continue
      }
      if (!entry.endsWith('.md') || !['textbooks', 'notes'].includes(parts.at(-1))) continue
      const sub = parts.at(-1)
      out.push({
        course: parts.slice(0, -1).join('/'),
        sub,
        path,
        kind: sub === 'textbooks' ? 'volume' : 'note',
      })
    }
  }
  walk(root)
  return out
}

const docs = collectDocuments(dir)
console.log(`扫描 ${docs.length} 份文档（${dir}）\n`)

const stats = {
  volume: { n: 0, chapters: 0, guideMissing: 0, metaMissing: 0, blockField: 0, episodeField: 0, blockTitleField: 0, orphanItems: 0 },
  note: { n: 0, chapters: 0, guideMissing: 0, metaMissing: 0, blockField: 0, episodeField: 0, blockTitleField: 0, orphanItems: 0 },
}
const warnings = []
const notes = []

/** 归一化用于比对：去不可见字符、去序号前缀与标点 */
function norm(s) {
  return s
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/\$\\?([A-Za-z]+)\$/g, '$1')
    .replace(/\\varepsilon/g, 'epsilon')
    .replace(/varepsilon/g, 'epsilon')
    .replace(/\\epsilon/g, 'epsilon')
    .replace(/\\([A-Za-z]+)/g, '$1')
    .replace(/\$/g, '')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/[（(]?P\d+(?:[-–—−]P?\d+)?[）)]?/gi, '')
    .replace(/^\s*\d+[.、]\s*/, '')
    .replace(/^\s*P?\d+[-–—]?/, '')
    .replace(/[\s　:：、，,。.()（）【】\[\]"'`]/g, '')
    .toLowerCase()
}

for (const doc of docs) {
  const md = readFileSync(doc.path, 'utf8')
  const d = splitDocument(md)
  const s = stats[doc.kind]
  s.n += 1
  s.chapters += d.chapters.length

  const guide = d.parts.find((p) => p.role === 'guide')
  // 册必须有导读（实测 158/158 都有）；笔记本来就没有，不算问题
  if (doc.kind === 'volume' && !guide) {
    s.guideMissing += 1
    warnings.push({ doc, text: '册没有导读节 —— 可能出现了新的标题变体，需要核对' })
  }

  // 核心校验：导读列出的每一条，都应当能在某一章的标题里找到对应。
  //
  // 注意这里**不要求数量相等**：实测变态心理学 模块06 的导读是残缺的（列 3 条、正文 6 章），
  // 那是内容滞后，不是切分错误。真正要抓的是"导读说了的章，切分后找不到"——那才是章序号错位。
  if (guide && d.chapters.length > 0) {
    const items = guide.markdown
      .split(/\r?\n/)
      .filter((l) => /^\s*\d+[.、]\s+\S/.test(l))
      .map((l) => norm(l.replace(/^\s*\d+[.、]\s*/, '')))
    const titles = d.chapters.map((c) => norm(c.title))
    let orphan = 0
    for (const item of items) {
      if (!titles.some((t) => t.includes(item) || item.includes(t))) orphan += 1
    }
    if (orphan > 0) {
      s.orphanItems += orphan
      warnings.push({ doc, text: `导读有 ${orphan}/${items.length} 条在正文里找不到对应章 —— 导读与正文可能不同步` })
    }
  }

  for (const w of d.warnings) warnings.push({ doc, text: w })
  // 笔记没有导读是常态，这类观察项不报（只在册上关注）
  if (doc.kind === 'volume') {
    for (const n of d.notes) notes.push({ doc, text: n })
  }

  if (doc.kind === 'volume') {
    const first = d.chapters[0]
    if (!first?.meta) s.metaMissing += 1
    if (first?.meta?.block) s.blockField += 1
    if (first?.meta?.episodes) s.episodeField += 1
    if (first?.meta?.blockTitle) s.blockTitleField += 1
  }
}

for (const kind of ['volume', 'note']) {
  const s = stats[kind]
  const label = kind === 'volume' ? '册' : '笔记'
  console.log(`【${label}】${s.n} 份，共 ${s.chapters} 章，平均 ${(s.chapters / Math.max(1, s.n)).toFixed(1)} 章/份`)
  if (kind === 'volume') {
    console.log(`  导读条目无对应章: ${s.orphanItems}   导读缺失: ${s.guideMissing}   首章 meta 缺失: ${s.metaMissing}`)
    console.log(`  章头字段命中: 对应块 ${s.blockField} / 覆盖分集 ${s.episodeField} / 标题 ${s.blockTitleField}`)
  }
  console.log()
}

if (notes.length) {
  console.log(`观察项 ${notes.length} 条（已按规则处理，非问题）：`)
  for (const n of notes.slice(0, 10)) {
    console.log(`  · ${n.doc.path.replace(dir, '').replace(/\\/g, '/').split('/').slice(-2).join('/')}`)
    console.log(`    ${n.text}`)
  }
  if (notes.length > 10) console.log(`  … 另有 ${notes.length - 10} 条`)
  console.log()
}

if (warnings.length) {
  console.log(`⚠ 需要处理 ${warnings.length} 处：`)
  for (const w of warnings.slice(0, 25)) {
    console.log(`  · [${w.doc.kind}] ${w.doc.path.replace(dir, '').replace(/\\/g, '/')}`)
    console.log(`    ${w.text}`)
  }
  if (warnings.length > 25) console.log(`  … 另有 ${warnings.length - 25} 处`)
  process.exitCode = 1
} else {
  console.log('通过：无告警，章序号与导读逐条对齐。')
}
