/**
 * 册内全文搜索（住在阅读页左栏的「搜索」tab）。
 *
 * ## 为什么不需要索引
 *
 * 整册已经在内存里渲染完了（`.reader-body` 里就是全部 DOM），所以搜索就是「把每个块的
 * `textContent` 扫一遍」。实测 283 KB 的那一册约 1200 个块，**惰性建一次索引 < 20ms**，
 * 之后每次改查询词都是纯内存子串扫描。因此不需要倒排索引、不需要分词、不需要 worker。
 *
 * **跨库全文检索是另一件事**（要构建期建索引，docs/00 §11 D3 归 v2）——这里只搜当前册。
 *
 * ## 定位方式
 *
 * 跳转后给那个块加一个 `.search-hit` class 做视觉标记。**不重跑渲染管线、不改 hast**，
 * 只是一次 DOM 操作——这是"高亮命中"最省的实现，也避免把搜索概念渗进 Markdown 管线。
 */
import { useMemo, useState, type RefObject } from 'react'
import type { BlockContext, DocumentId } from '../types.ts'

export type SearchBlock = {
  id: string
  chapterIndex: number
  /** 所在章（sectionPath 的第一段；册首块没有章，留空） */
  where: string
  text: string
}

type Hit = SearchBlock & { at: number }

/** 每次查询最多列出多少条 */
const MAX_HITS = 80
/** 片段里命中位置前后各取多少字符 */
const BEFORE = 24
const AFTER = 60

export function DocSearch({
  blocksRef,
  blockIndexRef,
  onJump,
}: {
  blocksRef: RefObject<{ id: string; el: HTMLElement }[]>
  blockIndexRef: RefObject<Map<string, BlockContext>>
  onJump: (blockId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<SearchBlock[] | null>(null)

  /** 首次搜索时才建索引（惰性），之后一直复用 */
  const ensureIndex = (): SearchBlock[] => {
    if (index) return index
    const blocks = blocksRef.current ?? []
    const index2 = blocks.map(({ id, el }) => {
      const ctx = blockIndexRef.current?.get(id)
      return {
        id,
        chapterIndex: ctx?.chapterIndex ?? 0,
        where: ctx?.sectionPath[0] ?? '',
        // 块内换行归一成空格：片段里出现真实换行会撑乱结果列表
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }
    })
    setIndex(index2)
    return index2
  }

  const { hits, total } = useMemo(() => {
    const q = query.trim()
    if (!q) return { hits: [] as Hit[], total: 0 }
    const needle = q.toLowerCase()
    const all: Hit[] = []
    for (const block of index ?? []) {
      const at = block.text.toLowerCase().indexOf(needle)
      if (at >= 0) all.push({ ...block, at })
    }
    return { hits: all.slice(0, MAX_HITS), total: all.length }
    // index 进依赖：建完索引后要用新索引重算一次
  }, [query, index])

  const onQuery = (value: string) => {
    setQuery(value)
    if (value.trim()) ensureIndex()
  }

  return (
    <div className="rail-search">
      <input
        type="search"
        className="rail-search-input"
        placeholder="在本册里搜…"
        value={query}
        autoFocus
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) onJump(hits[0].id)
        }}
      />

      {query.trim() === '' ? (
        <p className="rail-empty">整册已在本地，搜索不需要联网。</p>
      ) : total === 0 ? (
        <p className="rail-empty">本册没有包含「{query.trim()}」的段落。</p>
      ) : (
        <>
          <p className="rail-search-count">
            {total} 处{total > hits.length ? `（先列出前 ${hits.length} 处）` : ''}
          </p>
          <ul className="rail-hits">
            {hits.map((hit) => (
              <li key={hit.id}>
                <button type="button" className="rail-hit" onClick={() => onJump(hit.id)}>
                  {hit.where && <span className="rail-hit-where">{hit.where}</span>}
                  <span className="rail-hit-text">{snippet(hit.text, hit.at, query.trim().length)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** 命中片段：前后各取一段，命中处用 <mark> 标出 */
function snippet(text: string, at: number, len: number) {
  const from = Math.max(0, at - BEFORE)
  const to = Math.min(text.length, at + len + AFTER)
  return (
    <>
      {from > 0 ? '…' : ''}
      {text.slice(from, at)}
      <mark>{text.slice(at, at + len)}</mark>
      {text.slice(at + len, to)}
      {to < text.length ? '…' : ''}
    </>
  )
}

export type { DocumentId }
