/**
 * 公式解析护栏：把「明显是解析失控」的数学节点退回成纯文本。
 *
 * ## 为什么需要它（实测，不是假想）
 *
 * 有一册里出现了这样的写法：
 *
 *   1367: $$\frac{25.5}{34}\approx \dots = 25.16
 *   1368: eq 25.5$$
 *
 * 按 micromark 的数学扩展，**展示公式的收尾 `$$` 必须出现在行首**。1368 行的 `$$` 在行尾，
 * 所以它不构成收尾 —— 那块公式一直开到下一处行首 `$$`（在 3094 行），
 * **一口气吞掉 1700 多行、6 个章标题**。全库扫描因此有 28 条导读条目找不到对应章，
 * 章数从 1137 掉到 1109。
 *
 * 如果照单全收，阅读器会把一册的后半本渲染成一个巨型公式——没有任何读者会认为那是作者的意图。
 *
 * ## 判定规则（保守，只打"解析失控"，不碰正常公式）
 *
 * 一个数学节点满足任一条即判为失控，退回纯文本：
 *   - 跨行：展示公式超过 `maxLines` 行（默认 12——正常展示公式极少超过几行）
 *   - 内含看起来像标题的行（`^#{1,6} `）
 *   - 内联公式长度超过 `maxInlineChars`（默认 300）
 *
 * 退回的方式是替换成 `text`/`paragraph` 节点，于是原文（含 `$$`）**按纯文本显示出来**——
 * 用户看到的是"这里有一处公式没写对"，而不是"我读到一半变成公式了"。
 *
 * 与嵌套围栏那次不同：那次的两种坏法方向相反、阅读器侧无解（见 docs/03 §1.3 纪律三）；
 * 这次的坏法是单向的（只有失控，没有"本该是公式却被当文本"），所以护栏是净收益。
 */
import type { Root, RootContent } from 'mdast'
import { visit } from 'unist-util-visit'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

export type MathGuardOptions = {
  maxLines?: number
  maxInlineChars?: number
  /** 重解析的递归上限，防止病态内容反复触发 */
  maxDepth?: number
}

export type MathGuardHit = { kind: 'math' | 'inlineMath'; from: number; to: number; reason: string }

/** 重解析用的解析器。与主解析链保持一致（gfm + math），否则恢复出来的结构会不一样 */
function buildParser() {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze()
}
let parser: ReturnType<typeof buildParser> | undefined
function getParser() {
  parser ??= buildParser()
  return parser
}

/**
 * 原地清理失控的数学节点，返回命中记录。
 *
 * 处理方式是**把那块区域重新解析**，而不是简单换成一段文字。原因：标题在解析阶段
 * 就已经被吞进 math 节点里了，事后改文本救不回来——只有重解析才能把章标题恢复成标题。
 * 重解析前先把区域内的 `$$` 转义掉（`\$\$`），否则同一个坏定界符会再次吞掉后续内容；
 * 区域内的**行内公式 `$…$` 保持原样**，它们本来就是好的。
 *
 * 注意：这里是**直接调用的函数**，不是 unified 插件。
 * 原因：`unified().parse()` 只跑解析器、不跑 transformer 链，写成插件不会被调用。
 * （remark-math 能在 parse 阶段生效，是因为它注册的是 micromark 解析器扩展，不是 transformer。）
 */
export function guardRunawayMath(tree: Root, options: MathGuardOptions = {}): MathGuardHit[] {
  const { maxLines = 12, maxInlineChars = 300, maxDepth = 3 } = options
  const hits: MathGuardHit[] = []

  const walk = (root: Root, depth: number): void => {
    visit(root, (node, index, parent) => {
      if (node.type !== 'math' && node.type !== 'inlineMath') return
      if (index === undefined || !parent) return

      const value = node.value ?? ''
      const lines = value.split('\n').length
      const startLine = node.position?.start.line ?? 0
      const endLine = node.position?.end.line ?? 0
      const spansLines = endLine - startLine + 1

      let reason: string | undefined
      if (node.type === 'math' && (lines > maxLines || spansLines > maxLines)) {
        reason = `展示公式跨 ${Math.max(lines, spansLines)} 行（上限 ${maxLines}）`
      } else if (node.type === 'inlineMath' && value.length > maxInlineChars) {
        reason = `行内公式 ${value.length} 字符（上限 ${maxInlineChars}）`
      } else if (/^#{1,6} /m.test(value)) {
        reason = '公式内容里出现了标题行'
      }
      if (!reason) return

      hits.push({ kind: node.type, from: startLine, to: endLine, reason })

      if (node.type === 'inlineMath') {
        // 行内公式在段落内部 → 换成原样的文本
        parent.children.splice(index, 1, { type: 'text', value: `$${value}$` })
        return
      }

      // 展示公式：把区域重新解析（转义 $$ 防再次吞），递归处理嵌套情况
      const cleaned = value.replace(/\$\$/g, '\\$\\$')
      let replacement: RootContent[] = [{ type: 'paragraph', children: [{ type: 'text', value: cleaned }] }]
      if (depth < maxDepth) {
        try {
          const reparsed = getParser().parse(cleaned)
          walk(reparsed, depth + 1)
          replacement = reparsed.children.length > 0 ? reparsed.children : replacement
        } catch {
          /* 重解析失败就用纯文本兜底 */
        }
      }
      parent.children.splice(index, 1, ...replacement)
    })
  }

  walk(tree, 0)
  return hits
}
