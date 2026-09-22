/**
 * 块锚点：给每个块级节点一个确定性 id，并顺带产出大纲与块→章节路径的索引。
 *
 * 为什么需要（docs/03 §9.1）：
 *   - 划词时要知道"用户引的是哪一段"，得先能定位到块
 *   - TOC 跳转、搜索命中跳转、书签跳转、恢复上次位置都用同一套 id
 *   - `getBlockContext(blockId)` 要能反查出「这是第几章的第几节」
 *
 * **块 id 不是稳定标识**：文档改版后块序号会漂移。所以它只用于本次解析内的定位，
 * 跨会话/改版后的权威定位是 `chapterIndex` + `sectionPath` + 原文（docs/03 §9.1）。
 * id 形如 `<部件序号>-<块序号>`，部件序号来自 splitDocument 的 ordinal，保证全文唯一。
 */
import type { Element, ElementContent, Root } from 'hast'
import type { DocPartRole } from '../model/split-document.ts'

export type BlockAnchorResult = {
  /** blockId → 它属于哪一章、在哪条标题路径下 */
  blockIndex: Map<string, { chapterIndex: number; sectionPath: string[] }>
  /** 目录条目。**只收正文章**——册首/导读/小结的 H2 不进 TOC，否则目录里会混入非章节项 */
  outline: { title: string; level: 2 | 3; blockId: string; children: { title: string; level: 3; blockId: string }[] }[]
}

function toText(node: ElementContent | Element): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map((c) => toText(c as ElementContent)).join('')
  return ''
}

/** 会被当作"块"赋 id 的标签。行内元素（span/a/code/em/strong）不在此列 */
const BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'pre', 'table', 'div', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'hr',
])

export function rehypeBlockAnchors(opts: {
  ordinal: number
  chapterIndex: number
  chapterTitle: string
  /** 只有正文章贡献目录条目 */
  role: DocPartRole
  result: BlockAnchorResult
}) {
  const { ordinal, chapterIndex, chapterTitle, role, result } = opts
  const inOutline = role === 'chapter'

  return (tree: Root): void => {
    let blockNo = 0
    /** 当前所在的 H3 / H4 标题 */
    let h3: string | undefined
    let h4: string | undefined
    let lastTop: { title: string; level: 2 | 3; blockId: string; children: { title: string; level: 3; blockId: string }[] } | undefined

    for (const node of tree.children) {
      if (node.type !== 'element') continue

      const tag = node.tagName
      const headingLevel = /^h([1-6])$/.exec(tag)?.[1]

      if (headingLevel) {
        const level = Number(headingLevel)
        blockNo += 1
        const id = `${ordinal}-${blockNo}`

        if (level <= 4) {
          node.properties = { ...node.properties, id, 'data-block-id': id }
        }

        if (level <= 3 && inOutline) {
          const title = toText(node).trim()
          if (level === 2) {
            h3 = undefined
            h4 = undefined
            lastTop = { title, level: 2, blockId: id, children: [] }
            result.outline.push(lastTop)
          } else {
            // H3：挂到最近的 H2 下（没有 H2 时自建一个顶层项）
            if (!lastTop || lastTop.level !== 2) {
              lastTop = { title: chapterTitle, level: 2, blockId: id, children: [] }
              result.outline.push(lastTop)
            }
            h3 = title
            h4 = undefined
            lastTop.children.push({ title, level: 3, blockId: id })
          }
        } else if (level <= 3) {
          // 非正文章部件：仍要维护 sectionPath（块索引要用），但不进 TOC
          const title = toText(node).trim()
          if (level === 2) {
            h3 = undefined
            h4 = undefined
          } else {
            h3 = title
            h4 = undefined
          }
        } else if (level === 4) {
          // H4 进 sectionPath，但**不进 TOC**（避免目录过长，docs/03 §9.2）
          h4 = toText(node).trim()
        }
        // H5/H6 不参与

        result.blockIndex.set(id, {
          chapterIndex,
          sectionPath: [chapterTitle, h3, h4].filter((s): s is string => Boolean(s)),
        })
        continue
      }

      if (!BLOCK_TAGS.has(tag)) continue

      blockNo += 1
      const id = `${ordinal}-${blockNo}`
      node.properties = { ...node.properties, 'data-block-id': id }
      result.blockIndex.set(id, {
        chapterIndex,
        sectionPath: [chapterTitle, h3, h4].filter((s): s is string => Boolean(s)),
      })
    }
  }
}
