/**
 * 阅读器主视图：整册连续滚动（**不分页、不虚拟滚动**）。
 *
 * 不分页的理由（仓库 README）：「模块顺序与课程讲授顺序一致，读起来是连贯的教材而不是拼凑的笔记」。
 * 不虚拟滚动的理由（docs/03 §10.2）：它会破坏浏览器原生选中/复制、`Ctrl+F`、滚动锚点这三件阅读核心能力。
 * 一册渲染后约 3 千~1.3 万 DOM 节点，实测可接受；真要优化用 `content-visibility` 而不是虚拟化。
 *
 * 本组件**不认识** AI、会话、插件 —— 只发事件、只暴露导航原语（docs/00 §4 不变量 3）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { splitDocument, type SplitDocument } from '../model/split-document.ts'
import { createAnchorResult, renderPart } from '../markdown/render.ts'
import type { BlockContext, ContentSource, DocumentId, OutlineNode, ReaderApi, ReadingEvents, ReaderSlots } from '../types.ts'

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

    // 大纲只含正文章（册首/导读/小结不进 TOC），这一步在 anchors 插件里就做完了
    const tree2: OutlineNode[] = result.outline.map((n) => ({
      title: n.title,
      level: 2 as const,
      blockId: n.blockId,
      children: n.children.map((c) => ({ title: c.title, level: 3 as const, blockId: c.blockId, children: [] })),
    }))

    blockIndexRef.current = result.blockIndex
    outlineRef.current = tree2
    return { nodes, outline: tree2, parts }
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

  // ---- 暴露导航原语 ----
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      scrollToBlock: (blockId) => {
        const hit = blocksRef.current.find((b) => b.id === blockId) ?? blocksRef.current.find((b) => blockIndexRef.current.get(b.id)?.chapterIndex === Number(blockId))
        hit?.el.scrollIntoView({ block: 'start' })
      },
      getBlockContext: (blockId) => blockIndexRef.current.get(blockId),
      getOutline: () => outlineRef.current,
      getPosition: () => currentChapter(),
    }
    return () => {
      if (apiRef) apiRef.current = null
    }
  }, [apiRef, currentChapter])

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

  return (
    <div className="reader" ref={bodyRef}>
      {rendered?.outline.length ? <Toc outline={rendered.outline} onJump={(id) => apiRef?.current?.scrollToBlock(id)} /> : null}
      <article className="reader-body">
        {slots?.toolbarSlot}
        {rendered?.nodes}
        <footer className="reader-foot">
          <span>{state.split.parts.filter((p) => p.role === 'chapter').length} 章 · 读完</span>
        </footer>
      </article>
      {slots?.sidePanel}
      {slots?.selectionActionsSlot}
    </div>
  )
}

/** 章级目录 + scroll-spy。H4 不进目录（避免过长，docs/03 §9.2） */
function Toc({ outline, onJump }: { outline: OutlineNode[]; onJump: (blockId: string) => void }) {
  const [active, setActive] = useState<string>('')
  const navRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const headings = outline
      .map((n) => document.getElementById(n.blockId))
      .filter((el): el is HTMLElement => el !== null)
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
  }, [outline])

  return (
    <nav className="toc" ref={navRef} aria-label="目录">
      {outline.map((n) => (
        <div key={n.blockId} className="toc-chapter">
          <button
            type="button"
            className={active === n.blockId ? 'toc-item active' : 'toc-item'}
            onClick={() => onJump(n.blockId)}
          >
            {n.title}
          </button>
          {n.children.length > 0 && (
            <div className="toc-sections">
              {n.children.map((c) => (
                <button
                  key={c.blockId}
                  type="button"
                  className={active === c.blockId ? 'toc-sub active' : 'toc-sub'}
                  onClick={() => onJump(c.blockId)}
                >
                  {c.title}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  )
}
