/**
 * 把一册 Markdown 拆成「册首 / 导读 / 正文章 / 小结」四种部件。
 *
 * 为什么必须拆（docs/03 §1.4、§9）：章是**对话注入单位**（一篇模块长文），要能单独取出；
 * 块锚点要按章编号，划词与滚动定位才有稳定前缀；每章可单独解析并缓存。
 *
 * ## 两条踩出来的教训（别改回去）
 *
 * **1. 标题识别必须交给解析器，不能用正则扫行。**
 *    最初用 `/^## /` 扫行，把**代码围栏内**长得像标题的行也当成了真标题。实测三个案例全由此而来：
 *      · pink老师 模块02：围栏里有 4 行「## 二级标题（核心业务模块，对应 h2）」——那章是教 Markdown 语法的
 *      · 黑马 模块09：围栏里有 6 行「##     购物车系统     ##」——那是程序输出菜单的示意图
 *      · 变态心理学 模块06：围栏里有 3 行
 *    改用 remark 后，这三处的章数分别变成 10 / 11 / 6，与内容一致。
 *
 * **2. 「导读列出的章数」不是权威，内容才是。**
 *    曾按导读条目数截断章数，被变态心理学 模块06 证伪：它正文有 6 章，而导读只列了 3 条（导读残缺）。
 *    所以现在是**结构派生**（H2 序列排除首部导读与末位小结），导读条目数只作**诊断提示**。
 *
 * 全库校验：`node scripts/check-split.mjs`（扫 158 册 + 115 篇笔记，核对章序号与导读对齐）。
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { toString } from 'mdast-util-to-string'
import type { Root, RootContent } from 'mdast'
import { guardRunawayMath, type MathGuardHit } from '../markdown/math-guard.ts'
export type DocPartRole = 'head' | 'guide' | 'chapter' | 'summary'

/** 章头引用块解析结果。两套批次格式都覆盖（docs/03 §1.2） */
export type ChapterMeta = {
  /** 晚期批次：`对应块：BLK01` */
  block?: string
  /** 覆盖分集：晚期是区间 `P01-P07`，早期是单集 `P12` */
  episodes?: string
  /** 晚期：`块标题（分集名）：《…》`；早期：`原始标题：《…》` */
  blockTitle?: string
  raw: string
}

export type DocPart = {
  /** 全文唯一序号，用作块 id 前缀（保证跨部件的块 id 不冲突） */
  ordinal: number
  role: DocPartRole
  /** 章会话的键；head / guide / summary 为 0（不参与章会话，docs/04 §1.1） */
  chapterIndex: number
  title: string
  /** 该部件对应的顶层节点区间 [start, end)，渲染时直接取 tree.children 的这一段 */
  nodeRange: [number, number]
  /** 原文切片，用于引用、诊断与骨架生成 */
  markdown: string
  /** 仅 chapter 有 */
  meta?: ChapterMeta
}

export type SplitDocument = {
  /** 册标题（H1） */
  title: string
  /** 册首元信息块里出现的标签，如 ['所属课程','本册内容','覆盖范围',…] */
  metaLabels: string[]
  /** 解析后的整棵树。渲染层复用它，避免二次解析 */
  tree: Root
  /** 按原文顺序的全部部件——整册连续滚动就是按这个顺序渲染 */
  parts: DocPart[]
  /** 正文章（TOC、章会话、进度都用它） */
  chapters: DocPart[]
  /** 需要处理的问题 */
  warnings: string[]
  /** 已按规则处理、但值得知道的观察（不表示有问题） */
  notes: string[]
}

/** 剥离不可见字符（零宽 / BOM 等）并归一空白 */
function normalizeTitle(s: string): string {
  return s
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 解析章头引用块：`> 对应块：BLK01 | 覆盖分集：P01-P07 | 块标题（分集名）：《…》` */
export function parseChapterMeta(quote: string): ChapterMeta | undefined {
  const raw = quote.replace(/^>\s?/, '').trim()
  // 章头引用块一定带 `：` 分隔的字段；不是这种形状就不是章头
  if (!/：/.test(raw)) return undefined

  const meta: ChapterMeta = { raw }
  for (const seg of raw.split('|')) {
    const m = /^\s*\*{0,2}([^：*]+?)\*{0,2}\s*：\s*(.+?)\s*$/.exec(seg)
    if (!m) continue
    const label = normalizeTitle(m[1])
    const value = m[2].replace(/^《|》$/g, '').trim()
    if (label === '对应块') meta.block = value
    else if (label === '覆盖分集' || label === '对应分集') meta.episodes = value
    else if (label.includes('块标题') || label === '原始标题') meta.blockTitle = value
  }
  return meta.block || meta.episodes || meta.blockTitle ? meta : undefined
}

/** 取章标题之后紧跟的引用块（章头元信息就长这样）；要跳过开头的 H2 本身 */
function leadingQuote(nodes: readonly RootContent[]): string | undefined {
  for (let i = 1; i < nodes.length; i += 1) {
    const n = nodes[i]
    if (n.type === 'paragraph' && toString(n).trim() === '') continue
    if (n.type !== 'blockquote') return undefined
    const first = toString(n).split('\n')[0]?.trim()
    return first ? `> ${first}` : undefined
  }
  return undefined
}

/** 数导读节里的有序列表条目数 —— 只用于诊断，不参与切分 */
function countOrderedItems(nodes: readonly RootContent[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.type !== 'list' || node.ordered !== true) continue
    n += node.children.length
  }
  return n
}

/** 册首元信息块的标签，如 所属课程 / 本册内容 / 覆盖范围 … */
function collectMetaLabels(nodes: readonly RootContent[]): string[] {
  const labels: string[] = []
  for (const node of nodes) {
    if (node.type !== 'blockquote') continue
    const text = toString(node)
    const re = /([^\n：:*]{1,16})[：:]/g
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const label = normalizeTitle(m[1])
      if (label) labels.push(label)
    }
  }
  return labels
}

/**
 * 用**解析器的位置信息**切原文。
 * 这是「标题识别交给解析器」这条纪律的落点：位置来自 mdast，代码围栏天然被正确跳过。
 */
function sliceRange(markdown: string, children: readonly RootContent[], start: number, end: number): string {
  const from = children[start]?.position?.start.offset
  const to = children[end - 1]?.position?.end.offset
  if (from === undefined || to === undefined) return ''
  return markdown.slice(from, to)
}

export function splitDocument(markdown: string): SplitDocument {
  const warnings: string[] = []
  const notes: string[] = []

  // 解析一次，渲染层复用这棵树（避免二次解析）。
  // remark-math 必须在这里：全库 203 个文件含行内公式（`$V$`、`$5\text{-HT}_{2C}$` 这类），
  // 公式是硬需求——README 也专门提醒读者 Typora 要勾「内联公式」才不显示源码。
  // 注意 remark-math 注册的是解析器扩展，所以在 parse 阶段就生效。
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root

  // 解析失控的公式护栏（**必须在 parse 之后手工调用**：它是 transformer，parse 不会跑 transformer 链）。
  // 收尾 `$$` 没写在行首时，一块公式能吞掉上千行与多个章标题——实测发生过。
  const mathHits: MathGuardHit[] = guardRunawayMath(tree)
  const children = tree.children

  /** 顶层 H2 及其在 children 中的下标 */
  const h2: { idx: number; title: string }[] = []
  children.forEach((node, idx) => {
    if (node.type === 'heading' && node.depth === 2) h2.push({ idx, title: normalizeTitle(toString(node)) })
  })

  // 导读：第一个标题含「全景目录」的 H2（用**包含**而非等值，绕开两套标题与不可见字符）
  const guideH2 = h2.findIndex((h) => h.title.includes('全景目录'))
  // 小结：最后一个标题含「小结」或「总结」的 H2（早期批次是「模块 NN 全景总结与技术沉淀」）
  let summaryH2 = -1
  for (let i = h2.length - 1; i >= 0; i -= 1) {
    if (/小结|总结/.test(h2[i].title)) {
      summaryH2 = i
      break
    }
  }

  // 注意：这里都记为 notes 而不是 warnings —— 拆分器不认识"这是册还是笔记"，
  // 而**笔记本来就没有导读**。是否算问题由调用方按文档类型判定（见 scripts/check-split.mjs）。
  if (guideH2 === -1) notes.push('未找到导读节（标题含「全景目录」的 H2）')
  if (guideH2 !== -1 && summaryH2 === -1) notes.push('未找到小结节——末章按正文章处理')

  const parts: DocPart[] = []
  let ordinal = 0

  // 1) 册首：文档开头到第一个 H2（含 H1 与元信息块）
  const firstH2Idx = h2[0]?.idx ?? children.length
  const headNodes = children.slice(0, firstH2Idx)
  const h1 = children.find((n) => n.type === 'heading' && n.depth === 1)
  const title = h1 ? normalizeTitle(toString(h1)) : '（无标题）'
  if (headNodes.length > 0) {
    parts.push({
      ordinal: ordinal++,
      role: 'head',
      chapterIndex: 0,
      title,
      nodeRange: [0, firstH2Idx],
      markdown: sliceRange(markdown, children, 0, firstH2Idx),
    })
  }

  // 2..n) 导读 / 正文章 / 小结：按 H2 顺序逐个切，**以内容为准**
  let chapterIndex = 0
  let guideItemCount = 0

  for (let i = 0; i < h2.length; i += 1) {
    const startIdx = h2[i].idx
    const endIdx = h2[i + 1]?.idx ?? children.length
    const range: [number, number] = [startIdx, endIdx]
    const md = sliceRange(markdown, children, startIdx, endIdx)

    if (i === guideH2) {
      guideItemCount = countOrderedItems(children.slice(startIdx, endIdx))
      parts.push({ ordinal: ordinal++, role: 'guide', chapterIndex: 0, title: h2[i].title, nodeRange: range, markdown: md })
    } else if (i === summaryH2) {
      parts.push({ ordinal: ordinal++, role: 'summary', chapterIndex: 0, title: h2[i].title, nodeRange: range, markdown: md })
    } else {
      chapterIndex += 1
      const quote = leadingQuote(children.slice(startIdx, endIdx))
      parts.push({
        ordinal: ordinal++,
        role: 'chapter',
        chapterIndex,
        title: h2[i].title,
        nodeRange: range,
        markdown: md,
        meta: quote ? parseChapterMeta(quote) : undefined,
      })
    }
  }

  const chapters = parts.filter((p) => p.role === 'chapter')

  // 诊断：导读条目数 vs 章数。**不参与切分**，只提示数据可能滞后（见文件头教训 2）
  if (guideItemCount > 0 && guideItemCount !== chapters.length) {
    notes.push(`导读列出 ${guideItemCount} 章，正文实际 ${chapters.length} 章 —— 两者之一有滞后，切分以正文为准`)
  }

  // 诊断：公式护栏命中了多少处失控（内容侧问题；阅读器已重解析，章结构与行内公式都保住了）
  if (mathHits.length > 0) {
    notes.push(
      `公式护栏拦下 ${mathHits.length} 处解析失控（已重解析，章结构已恢复）：` +
        mathHits.map((h) => `L${h.from}→${h.to} ${h.reason}`).join('；'),
    )
  }

  return { title, metaLabels: collectMetaLabels(headNodes), tree, parts, chapters, warnings, notes }
}
