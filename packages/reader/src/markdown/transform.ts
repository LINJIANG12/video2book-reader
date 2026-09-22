/**
 * Markdown → hast 的**纯管线**（不碰 React）。
 *
 *   mdast（splitDocument 已解析好，复用，不二次解析）
 *     → mdast-util-to-hast
 *     → rehype-katex          公式（全库 203 个文件含行内公式，是硬需求）
 *     → rehype-callouts       学习要素标注
 *     → rehype-block-anchors  块锚点 + 大纲
 *
 * 为什么单独一层而不直接到 React：
 *   1. 这一层是纯函数，**Node 能直接跑**（脚本可断言），而 .tsx 需要 JSX 转换、Node 跑不了
 *   2. 将来 AI 的「章骨架注入」要的是结构化的 hast/文本，不是 React 元素
 *
 * **故意不做的事：代码高亮不在这条管线里。**
 * Shiki 全量高亮会让长文档首屏明显卡（单册可能上百个代码块），所以代码块先按纯文本渲染，
 * 由 CodeBlock 组件进入视口后再高亮（docs/03 §5.3、§10.2）。管线因此保持同步、可预测。
 */
import type { Root as MdastRoot, RootContent } from 'mdast'
import type { Root as HastRoot } from 'hast'
import { toHast } from 'mdast-util-to-hast'
import { unified } from 'unified'
import rehypeKatex from 'rehype-katex'

import { rehypeCallouts } from './callouts.ts'
import { rehypeBlockAnchors, type BlockAnchorResult } from './anchors.ts'
import type { DocPart } from '../model/split-document.ts'

export function createAnchorResult(): BlockAnchorResult {
  return { blockIndex: new Map(), outline: [] }
}

/** 把一个部件转成 hast，并把块索引与大纲写进 `result` */
export function transformPart(tree: MdastRoot, part: DocPart, result: BlockAnchorResult): HastRoot {
  const children = tree.children.slice(part.nodeRange[0], part.nodeRange[1]) as RootContent[]
  const mdRoot: MdastRoot = { type: 'root', children }

  const hast = toHast(mdRoot, { allowDangerousHtml: false }) as HastRoot

  // 用 unified().use().runSync() 驱动插件的理由：手工调用 `plugin()(tree)` 会撞上
  // unified 的类型约定（transformer 第二个参数是 VFile），交给 unified 驱动最稳。
  unified()
    .use(rehypeKatex)
    .use(rehypeCallouts)
    .use(rehypeBlockAnchors, {
      ordinal: part.ordinal,
      chapterIndex: part.chapterIndex,
      chapterTitle: part.role === 'chapter' ? part.title : '',
      role: part.role,
      result,
    })
    .runSync(hast)

  return hast
}

/**
 * 整册转 hast（按部件顺序拼起来）。
 * 逐部件转而不是整册一次转的原因：各部件块 id 前缀不同，且「章会话」将来要单独取一章。
 */
export function transformDocument(tree: MdastRoot, parts: DocPart[]): { parts: HastRoot[]; result: BlockAnchorResult } {
  const result = createAnchorResult()
  return { parts: parts.map((p) => transformPart(tree, p, result)), result }
}

/** 从 hast 里取纯文本（供骨架生成、搜索、诊断使用） */
export function hastToText(node: HastRoot | RootContent | { type: string }): string {
  const n = node as { type: string; value?: string; children?: unknown[] }
  if (n.type === 'text') return n.value ?? ''
  if (!n.children) return ''
  return n.children.map((c) => hastToText(c as { type: string })).join('')
}
