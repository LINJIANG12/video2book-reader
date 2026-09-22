/**
 * hast → React 的最后一跳。
 *
 * 纯管线（mdast → hast）在 transform.ts 里，Node 可直接跑；这一层才需要 React，
 * 所以拆开——脚本能验证管线，浏览器只多验"样式好不好看"。
 */
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import type { ReactNode } from 'react'

import { transformPart } from './transform.ts'
import type { Root as MdastRoot } from 'mdast'
import type { DocPart } from '../model/split-document.ts'
import type { BlockAnchorResult } from './anchors.ts'
import { READER_COMPONENTS } from '../ui/components.tsx'

export { createAnchorResult, transformPart, transformDocument, hastToText } from './transform.ts'
export type { BlockAnchorResult } from './anchors.ts'

/** 渲染一个部件为 React 节点，并把块索引与大纲写进 `result` */
export function renderPart(tree: MdastRoot, part: DocPart, result: BlockAnchorResult): ReactNode {
  const hast = transformPart(tree, part, result)

  return toJsxRuntime(hast, {
    Fragment,
    jsx: jsx as never,
    jsxs: jsxs as never,
    components: READER_COMPONENTS as never,
  })
}
