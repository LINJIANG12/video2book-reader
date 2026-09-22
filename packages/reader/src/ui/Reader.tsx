/**
 * 阅读器主视图：整册连续滚动（**不分页、不虚拟滚动**）。
 *
 * 不分页的理由（仓库 README）：「模块顺序与课程讲授顺序一致，读起来是连贯的教材而不是拼凑的笔记」。
 * 不虚拟滚动的理由（docs/03 §10.2）：它会破坏浏览器原生选中/复制、`Ctrl+F`、滚动锚点这三件阅读核心能力。
 * 一册渲染后约 3 千~1.3 万 DOM 节点，实测可接受；真要优化用 `content-visibility` 而不是虚拟化。
 *
 * 左栏是**大纲 / 搜索**两个 tab（与 Typora 的「文件 / 大纲」同一模式）：
 * 大纲是四层可折叠的树，搜索是册内全文检索（整册已在内存，零索引成本）。
 *
 * 本组件**不认识** AI、会话、插件 —— 只发事件、只暴露导航原语（docs/00 §4 不变量 3）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { splitDocument, type SplitDocument } from '../model/split-document.ts'
import { createAnchorResult } from '../markdown/transform.ts'
import { renderPart } from '../markdown/render.ts'
import type { BlockContext, ContentSource, DocumentId, OutlineNode, ReaderApi, ReadingEvents, ReaderSlots } from '../types.ts'
import { DocSearch, type SearchBlock } from './DocSearch.tsx'

export type ReaderProps = {
  contentSource: ContentSource
  documentId: DocumentId
  events?: ReadingEvents
  slots?: ReaderSlots
  /** 由调用方拿到导航原语（供 AI 插件等使用） */
  apiRef?: { current: ReaderApi | null }
  /** 恢复上次阅读位置；块不存在时回退到章首 */
  initialBlockId?: string
  initialChapterIndex?: number
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; split: SplitDocument }
  | { phase: 'error'; message: string }

export function Reader({ contentSource, documentId, events, slots, apiRef, initialBlockId, initialChapterIndex }: ReaderProps) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [railTab, setRailTab] = useState<'outline' | 'search'>('outline')
  /** 窄屏下左栏收起为抽屉（< 860px 时大纲栏本来就被隐藏，等于手机上没大纲） */
  const [railDrawer, setRailDrawer] = useState(false)

  const bodyRef = useRef<HTMLDivElement>(null)
  /** 缓存所有块元素，供滚动定位做二分查找 */
  const blocksRef = useRef<{ id: string; el: HTMLElement }[]>([])
  const outlineRef = useRef<OutlineNode[]>([])
  const blockIndexRef = useRef(new Map<string, BlockContext>())
  const currentChapterRef = useRef(0)

  // ---- 加载与拆分 ----
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    setState({ phase: 'loading' })

    contentSource
      .loadDocument(documentId, ac.signal)
      .then((md) => {
        if (cancelled) return
        setState({ phase: 'ready', split: splitDocument(md) })
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ phase: 'error', message: e.message })
      })

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [contentSource, documentId])

  // ---- 渲染各部件（一次算完；解析结果随 split 缓存）----
  const rendered = useMemo(() => {
    if (state.phase !== 'ready') return null
    const { tree, parts } = state.split
    const result = createAnchorResult()

    const nodes: ReactNode[] = parts.map((part) => (
      <section key={part.ordinal} data-part-role={part.role} data-chapter-index={part.chapterIndex}>
        {renderPart(tree, part, result)}
      </section>
    ))

    // 大纲只含册标题与正文章（在 anchors 插件里就判完了）
    blockIndexRef.current = result.blockIndex
    outlineRef.current = result.outline
    return { nodes, outline: result.outline, parts }
  }, [state])

  // ---- 渲染后缓存块元素，并恢复上次位置 ----
  useEffect(() => {
    if (!rendered) return
    const root = bodyRef.current
    if (!root) return

    blocksRef.current = Array.from(root.querySelectorAll<HTMLElement>('[data-block-id]')).map((el) => ({
      id: el.dataset.blockId ?? '',
      el,
    }))

    const target = initialBlockId && blocksRef.current.find((b) => b.id === initialBlockId)
    if (target) {
      target.el.scrollIntoView({ block: 'start' })
    } else if (initialChapterIndex) {
      const fallback = blocksRef.current.find((b) => blockIndexRef.current.get(b.id)?.chapterIndex === initialChapterIndex)
      fallback?.el.scrollIntoView({ block: 'start' })
    }
  }, [rendered, initialBlockId, initialChapterIndex])

  const currentChapter = useCallback((): { chapterIndex: number; blockId: string } => {
    const root = bodyRef.current
    const blocks = blocksRef.current
    if (!root || blocks.length === 0) return { chapterIndex: 0, blockId: '' }

    // 二分找「最后一个顶部已滚过视口线」的块
    const line = root.scrollTop + 120
    let lo = 0
    let hi = blocks.length - 1
    let hit = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (blocks[mid].el.offsetTop <= line) {
        hit = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const block = blocks[hit]
    return { chapterIndex: blockIndexRef.current.get(block.id)?.chapterIndex ?? 0, blockId: block.id }
  }, [])

  // ---- 滚动上报：章切换与块变化各报一次，避免刷爆 ----
  useEffect(() => {
    if (!events?.onChapterEnter && !events?.onScrollAnchor) return
    const root = bodyRef.current
    if (!root) return

    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const pos = currentChapter()
        if (pos.chapterIndex && pos.chapterIndex !== currentChapterRef.current) {
          currentChapterRef.current = pos.chapterIndex
          events.onChapterEnter?.(documentId, pos.chapterIndex)
        }
        if (pos.blockId) events.onScrollAnchor?.(documentId, pos.chapterIndex, pos.blockId)
      })
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [events, documentId, currentChapter])

  /** 跳到一个块并把它标记出来（搜索命中定位用）。只加 class，不重跑渲染管线 */
  const scrollToBlock = useCallback((blockId: string) => {
    const hit = blocksRef.current.find((b) => b.id === blockId)
    if (!hit) return
    hit.el.scrollIntoView({ block: 'start' })
    for (const el of bodyRef.current?.querySelectorAll('.search-hit') ?? []) el.classList.remove('search-hit')
    hit.el.classList.add('search-hit')
  }, [])

  // ---- 暴露导航原语 ----
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      scrollToBlock,
      getBlockContext: (blockId) => blockIndexRef.current.get(blockId),
      getOutline: () => outlineRef.current,
      getPosition: () => currentChapter(),
    }
    return () => {
      if (apiRef) apiRef.current = null
    }
  }, [apiRef, currentChapter, scrollToBlock])

  if (state.phase === 'loading') {
    return <div className="reader-status">正在读取…</div>
  }
  if (state.phase === 'error') {
    return (
      <div className="reader-status reader-status-error">
        <p>这一册没能读出来。</p>
        <p className="detail">{state.message}</p>
      </div>
    )
  }

  const chapterCount = state.split.chapters.length

  return (
    <div className="reader" data-rail-open={railDrawer || undefined}>
      <button
        type="button"
        className="rail-toggle"
        aria-expanded={railDrawer}
        onClick={() => setRailDrawer((v) => !v)}
      >
        {railTab === 'outline' ? '大纲' : '搜索'}
      </button>

      <aside className="rail">
        <div className="rail-tabs" role="tablist">
          {(['outline', 'search'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={railTab === tab}
              className={railTab === tab ? 'rail-tab active' : 'rail-tab'}
              onClick={() => setRailTab(tab)}
            >
              {tab === 'outline' ? '大纲' : '搜索'}
            </button>
          ))}
        </div>

        {/* 两块面板都挂着、用 CSS 隐藏非当前的：切 tab 不会丢掉大纲的展开状态与搜索索引 */}
        <div className={railTab === 'outline' ? 'rail-panel' : 'rail-panel rail-panel-off'}>
          {rendered?.outline.length ? (
            <OutlineTree nodes={rendered.outline} onJump={scrollToBlock} />
          ) : (
            <p className="rail-empty">这一册没有可列的标题。</p>
          )}
        </div>
        <div className={railTab === 'search' ? 'rail-panel' : 'rail-panel rail-panel-off'}>
          <DocSearch blocksRef={blocksRef} blockIndexRef={blockIndexRef} onJump={scrollToBlock} />
        </div>
      </aside>

      <article className="reader-body" ref={bodyRef}>
        {slots?.toolbarSlot}
        {rendered?.nodes}
        <footer className="reader-foot">
          <span>{chapterCount} 章 · 读完</span>
        </footer>
      </article>
      {slots?.sidePanel}
      {slots?.selectionActionsSlot}
    </div>
  )
}

/** 从根到目标节点的祖先链（不含目标自身）。用于把当前所在路径自动展开 */
function pathTo(nodes: OutlineNode[], target: string, trail: OutlineNode[] = []): OutlineNode[] | undefined {
  for (const node of nodes) {
    if (node.blockId === target) return trail
    const deeper = pathTo(node.children, target, [...trail, node])
    if (deeper) return deeper
  }
  return undefined
}

/**
 * 大纲树 + scroll-spy。四层可折叠：册标题 → 章 → 节 → 小节。
 *
 * **默认收起第三层（节）以下的小节**：实测一册可以有 146 个 H4，全展开会让左栏初始就是
 * 两百多行，"一眼看到全局"反而失效。但当前所在位置所在的路径会自动展开，
 * 所以 scroll-spy 高亮的那一项永远不会藏在收起的分支里。
 */
function OutlineTree({ nodes, onJump }: { nodes: OutlineNode[]; onJump: (blockId: string) => void }) {
  const [active, setActive] = useState<string>('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  const ids = useMemo(() => {
    const out: string[] = []
    const walk = (list: OutlineNode[]) => {
      for (const n of list) {
        out.push(n.blockId)
        walk(n.children)
      }
    }
    walk(nodes)
    return out
  }, [nodes])

  // 初次进来先把「节」这一层收起（它们的小节最多）
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || nodes.length === 0) return
    seeded.current = true
    const third: string[] = []
    const walk = (list: OutlineNode[]) => {
      for (const n of list) {
        if (n.level === 3 && n.children.length > 0) third.push(n.blockId)
        walk(n.children)
      }
    }
    walk(nodes)
    if (third.length > 0) setCollapsed(new Set(third))
  }, [nodes])

  useEffect(() => {
    const headings = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null)
    if (headings.length === 0) return

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: '-15% 0px -75% 0px', threshold: 0 },
    )
    headings.forEach((h) => io.observe(h))
    return () => io.disconnect()
  }, [ids])

  // 当前位置换了 → 把它所在的整条路径展开，否则高亮项可能在被收起的分支里
  useEffect(() => {
    if (!active) return
    const trail = pathTo(nodes, active)
    if (!trail) return
    setCollapsed((prev) => {
      if (!trail.some((n) => prev.has(n.blockId))) return prev
      const next = new Set(prev)
      for (const n of trail) next.delete(n.blockId)
      return next
    })
  }, [active, nodes])

  const toggle = (blockId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(blockId)) next.delete(blockId)
      else next.add(blockId)
      return next
    })

  const render = (list: OutlineNode[]): ReactNode =>
    list.map((node) => {
      const hasChildren = node.children.length > 0
      const isCollapsed = collapsed.has(node.blockId)
      return (
        <li key={node.blockId} className={`outline-item outline-l${node.level}`}>
          <div className="outline-row">
            {hasChildren ? (
              <button
                type="button"
                className="outline-twisty"
                aria-label={isCollapsed ? '展开' : '收起'}
                aria-expanded={!isCollapsed}
                onClick={() => toggle(node.blockId)}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
            ) : (
              <span className="outline-twisty" aria-hidden="true" />
            )}
            <button
              type="button"
              className={active === node.blockId ? 'outline-link active' : 'outline-link'}
              title={node.title}
              onClick={() => onJump(node.blockId)}
            >
              {node.title}
            </button>
          </div>
          {hasChildren && !isCollapsed ? <ul className="outline-children">{render(node.children)}</ul> : null}
        </li>
      )
    })

  return <ul className="outline">{render(nodes)}</ul>
}

export type { SearchBlock }
