/**
 * 学习要素标注（callout）：把 `> **易错点**：…` 识别成结构化卡片。
 *
 * 这是阅读体验最大的增量——这套标签是流水线**已经产出的语义资产**
 * （全库统计：结论 1401 · 提示 1291 · 易错点 1025 · 定义 795 · 注意 253 · 承前启后 164 …），
 * 阅读器的价值之一就是把它显形：定义 / 结论 / 易错点一眼可辨，而不是都长成一样的引用块。
 *
 * 标签表是**数据驱动的**：出现新标签时退化为通用卡片，**不报警、不报错、不影响渲染**
 * （docs/03 §4.2 纪律 1）。分类只区分九类、色相不超过 4 个（纪律 2）。
 *
 * 实现在 rehype 阶段（而不是 remark 阶段）的理由：此时引用块已经变成 `<blockquote><p><strong>`
 * 这个稳定形状，不用给 mdast 做类型扩展，也少一层自定义节点。
 */
import type { Element, ElementContent, Root } from 'hast'
import { visit } from 'unist-util-visit'

export type CalloutKind =
  | 'definition'
  | 'conclusion'
  | 'tip'
  | 'warning'
  | 'transition'
  | 'meta'
  | 'figure'
  | 'question'
  | 'generic'

/** 标签 → 分类。来源：全库实测统计（docs/03 §4.2 的表） */
const LABEL_TO_KIND: Record<string, CalloutKind> = {
  定义: 'definition',
  结论: 'conclusion',
  核心结论: 'conclusion',
  核心机制: 'conclusion',
  核心原则: 'conclusion',
  核心规则: 'conclusion',
  核心原理: 'conclusion',
  一句话主旨: 'conclusion',
  提示: 'tip',
  易错点: 'warning',
  注意: 'warning',
  承前启后: 'transition',
  模块跨度: 'transition',
  内容定位: 'transition',
  关联说明: 'transition',
  所属课程: 'meta',
  本册内容: 'meta',
  覆盖范围: 'meta',
  分册说明: 'meta',
  整编说明: 'meta',
  读图说明: 'figure',
  图示说明: 'figure',
  题目: 'question',
  题干: 'question',
  解析: 'question',
  答案: 'question',
  需求描述: 'question',
  说明: 'generic',
  规则: 'generic',
  规范: 'generic',
}

/** 标签名最长允许几个字符——超过就不可能是标签，避免把正文里加粗的一句话误判成卡片 */
const MAX_LABEL_LEN = 16

function kindOf(label: string): CalloutKind {
  return LABEL_TO_KIND[label] ?? 'generic'
}

function toText(node: ElementContent | Element): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map((c) => toText(c as ElementContent)).join('')
  return ''
}

/** 段首是不是 `**标签**：…`。是则剥掉标签与紧跟的冒号，返回标签与剩余节点（原地不改输入） */
function takeLabel(seg: ElementContent[]): { label: string; rest: ElementContent[] } | undefined {
  const first = seg[0]
  if (!first || first.type !== 'element' || first.tagName !== 'strong') return undefined
  const label = toText(first).replace(/[\s\u200B-\u200D\uFEFF]/g, '')
  if (!label || label.length > MAX_LABEL_LEN) return undefined

  const rest = seg.slice(1)
  const head = rest[0]
  if (!head || head.type !== 'text' || !/^\s*[：:]/.test(head.value)) return undefined
  return { label, rest: [{ type: 'text', value: head.value.replace(/^\s*[：:]\s*/, '') }, ...rest.slice(1)] }
}

/** 去掉节点序列开头的空白（`<br>` 之后 mdast-util-to-hast 总会多跟一个 `"\n"` 文本节点，它是格式不是内容） */
function trimStart(nodes: ElementContent[]): ElementContent[] {
  const out = nodes.slice()
  while (out.length > 0) {
    const node = out[0]
    if (node.type !== 'text') break
    if (node.value.trim() === '') {
      out.shift()
      continue
    }
    out[0] = { type: 'text', value: node.value.replace(/^\s+/, '') }
    break
  }
  return out
}

/** 去掉行尾的空白（行尾双空格是 Markdown 的硬换行语法，不该显示出来） */
function trimEnd(nodes: ElementContent[]): ElementContent[] {
  const out = nodes.slice()
  while (out.length > 0) {
    const node = out[out.length - 1]
    if (node.type !== 'text') break
    if (node.value.trim() === '') {
      out.pop()
      continue
    }
    out[out.length - 1] = { type: 'text', value: node.value.replace(/\s+$/, '') }
    break
  }
  return out
}

/**
 * 把 children 按 `<br>`（Markdown 的行尾双空格）切段，并去掉段首空白。
 *
 * **段首那个 `"\n"` 一定要去掉**：mdast-util-to-hast 把硬换行渲染成 `<br>` + 一个 `"\n"` 文本节点，
 * 不去掉的话第二段起就以文本开头，标签识别会全部失败——这个坑实测踩过。
 */
function splitByBreak(children: ElementContent[]): ElementContent[][] {
  const segments: ElementContent[][] = []
  let current: ElementContent[] = []
  for (const child of children) {
    if (child.type === 'element' && child.tagName === 'br') {
      segments.push(current)
      current = []
    } else {
      current.push(child)
    }
  }
  segments.push(current)
  return segments.map(trimStart)
}

/**
 * 把「一个段落里的多行 `**标签**：值`」解构成元信息行。
 *
 * ## 为什么需要它（实测，不是假想）
 *
 * 册首元信息在源文件里是**一个引用块 + 若干行 `**标签**：值`，用行尾双空格分行**：
 *
 *   > **所属课程**：[完结] 2026 南京大学 "操作系统原理" (蒋炎岩)␠␠
 *   > **本册内容**：操作系统导论与 AI 时代的系统视角␠␠
 *   > **覆盖范围**：P01上 ~ P02下（共 2 讲 / 4 章 / 185 分钟音频）␠␠
 *
 * 而**旧实现只看第一个段落、只剥掉第一个 `<strong>`**，于是：
 *   · 第一行「所属课程」被做成胶囊标签 ✓
 *   · 其余各行的 `**模块跨度**：` 原样留在正文里，退化成普通的加粗文字 ✗
 *
 * 全库实测：**4 行 102 处 + 5 行 56 处 = 158 处，正好每一册一处**，
 * 且没有任何其他 kind 出现多行（所以这里不需要按 kind 设门槛）。
 *
 * 返回 `undefined` 表示"不是元信息表"，交回原有的单行逻辑处理——
 * 首段不带标签、或只有一行时都走那条路，行为与改动前完全一致。
 */
function parseMetaRows(paragraph: Element): { label: string; value: ElementContent[] }[] | undefined {
  const segments = splitByBreak(paragraph.children as ElementContent[])
  const rows: { label: string; value: ElementContent[] }[] = []

  for (const seg of segments) {
    const taken = takeLabel(seg)
    if (taken) {
      rows.push({ label: taken.label, value: taken.rest })
    } else if (rows.length > 0) {
      // 不构成新标签的段（例如值里自带换行）→ 并进上一行，用 <br> 还原换行，
      // 而不是整块退回旧行为——否则一处异常会让整册的元信息又变回半渲染
      const last = rows[rows.length - 1]
      last.value.push({ type: 'element', tagName: 'br', properties: {}, children: [] }, ...seg)
    } else {
      return undefined
    }
  }

  return rows.length >= 2 ? rows : undefined
}

export function rehypeCallouts() {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'blockquote') return
      const p = node.children.find((c): c is Element => c.type === 'element' && c.tagName === 'p')
      if (!p) return

      // 多行元信息表 → 解构成 <dl>，由 CSS 排成两列。**不设 data-label**：
      // 标签已经逐行在 dt 里，再挂一个胶囊会重复，而且只显示第一行会误导。
      const rows = parseMetaRows(p)
      if (rows) {
        const kind = kindOf(rows[0].label)
        node.tagName = 'div'
        node.properties = {
          ...node.properties,
          className: ['callout', `callout-${kind}`, 'callout-rows'],
          'data-callout': kind,
        }
        // 直接用 dt/dd 作为 dl 的子节点（不套 div）——因为 hast→React 的组件表把
        // 所有 div 都映射成 Callout，内层 div 会被误当成嵌套卡片渲染
        p.tagName = 'dl'
        p.properties = {}
        p.children = rows.flatMap(({ label, value }) => [
          { type: 'element', tagName: 'dt', properties: {}, children: [{ type: 'text', value: label }] },
          { type: 'element', tagName: 'dd', properties: {}, children: trimEnd(value) },
        ])
        return
      }

      // 单行：`> **标签**：正文`
      const taken = takeLabel(splitByBreak(p.children as ElementContent[])[0] ?? [])
      if (!taken) return

      const first = p.children[0]
      if (first && first.type === 'element' && first.tagName === 'strong') {
        p.children = p.children.slice(1)
        const head = p.children[0]
        if (head && head.type === 'text') head.value = head.value.replace(/^\s*[：:]\s*/, '')
      }
      node.tagName = 'div'
      node.properties = {
        ...node.properties,
        className: ['callout', `callout-${kindOf(taken.label)}`],
        'data-callout': kindOf(taken.label),
        'data-label': taken.label,
      }
    })
  }
}
