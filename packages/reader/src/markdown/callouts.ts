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

/** 是否形如 `**标签**：正文`；返回标签名 */
function detectLabel(blockquote: Element): string | undefined {
  const p = blockquote.children.find((c): c is Element => c.type === 'element' && c.tagName === 'p')
  if (!p) return undefined
  const first = p.children[0]
  if (!first || first.type !== 'element' || first.tagName !== 'strong') return undefined
  const label = toText(first).replace(/[\s\u200B-\u200D\uFEFF]/g, '')
  if (!label || label.length > MAX_LABEL_LEN) return undefined
  // 加粗之后必须是冒号（全角或半角），否则不是标签
  const rest = toText({ type: 'element', tagName: 'x', properties: {}, children: p.children.slice(1) } as Element)
  return /^\s*[：:]/.test(rest) ? label : undefined
}

/** 去掉 `**标签**：` 这一段，只留正文（避免既显示胶囊标签又显示加粗造成重复） */
function stripLabel(blockquote: Element): void {
  const p = blockquote.children.find((c): c is Element => c.type === 'element' && c.tagName === 'p')
  if (!p) return
  p.children = p.children.slice(1)
  const first = p.children[0]
  if (first && first.type === 'text') {
    first.value = first.value.replace(/^\s*[：:]\s*/, '')
  }
}

export function rehypeCallouts() {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'blockquote') return
      const label = detectLabel(node)
      if (!label) return

      const kind = kindOf(label)
      stripLabel(node)
      node.tagName = 'div'
      node.properties = {
        ...node.properties,
        className: ['callout', `callout-${kind}`],
        'data-callout': kind,
        'data-label': label,
      }
    })
  }
}
