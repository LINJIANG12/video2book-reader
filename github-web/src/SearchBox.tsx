/**
 * 顶栏全局搜索：搜**标题**（课程名 / 册 / 笔记 / 逐字稿）。
 *
 * 只搜标题不搜正文，是因为标题全在已经加载完的课程结构里，所以这个搜索是
 * **零网络、零索引、输入即出结果**的（实现在 `ContentSource.searchTitles`）。
 *
 * 交互升级：
 *   · 全局快捷键：⌘K / Ctrl+K 或 / 快速聚焦
 *   · 键盘上下键：自动将被选项目滚动进可视区域（scrollIntoView）
 *   · 命中词高亮：对搜索匹配文字标黄强调
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ContentSource, TitleHit } from '@app/reader'

/** 每组最多列几条（再多也没人看，且会把下拉撑爆） */
const PER_GROUP = 8

const GROUP_LABEL: Record<TitleHit['kind'], string> = {
  course: '课程',
  volume: '模块全书',
  note: '复习笔记',
  subtitle: '逐字稿',
}
const GROUP_ORDER: TitleHit['kind'][] = ['course', 'volume', 'note', 'subtitle']

function HighlightMatch({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim()
  if (!q) return text
  const lowerText = text.toLowerCase()
  const lowerQ = q.toLowerCase()
  const idx = lowerText.indexOf(lowerQ)
  if (idx === -1) return text

  return (
    <>
      {text.slice(0, idx)}
      <mark className="search-highlight">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}

export function SearchBox({
  contentSource,
  onOpenHit,
}: {
  contentSource: ContentSource
  onOpenHit: (hit: TitleHit) => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TitleHit[]>([])
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** 防抖只用来避免每敲一个字就重渲染下拉，查询本身是内存扫描，很快 */
  const timer = useRef<number | undefined>(undefined)

  // 全局快捷键支持：Ctrl+K / ⌘K 或在非输入框下按 /
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const cmdKey = isMac ? e.metaKey : e.ctrlKey
      if (cmdKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      } else if (e.key === '/' && document.activeElement !== inputRef.current && !['INPUT', 'TEXTAREA'].includes((document.activeElement?.tagName ?? ''))) {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    window.clearTimeout(timer.current)
    const q = query.trim()
    if (!q) {
      setHits([])
      return
    }
    timer.current = window.setTimeout(() => {
      contentSource
        .searchTitles(q)
        .then((found) => {
          setHits(found)
          setCursor(0)
        })
        .catch(() => setHits([]))
    }, 100)
    return () => window.clearTimeout(timer.current)
  }, [query, contentSource])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const groups = GROUP_ORDER.map((kind) => ({
    kind,
    all: hits.filter((h) => h.kind === kind),
  })).filter((g) => g.all.length > 0)
  const shown = groups.flatMap((g) => g.all.slice(0, PER_GROUP))
  const total = hits.length

  // 键盘上下选择时，确保选中的项目在视口内可见
  useEffect(() => {
    if (!open || shown.length === 0) return
    const activeEl = panelRef.current?.querySelector<HTMLElement>('.search-hit.active')
    activeEl?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open, shown.length])

  const open1 = (hit: TitleHit | undefined) => {
    if (!hit) return
    onOpenHit(hit)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="search" ref={boxRef}>
      <div className="search-field">
        <span className="search-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          ref={inputRef}
          type="search"
          className="search-input"
          placeholder="全库搜索课程、册、笔记..."
          role="combobox"
          aria-expanded={open && shown.length > 0}
          aria-controls="search-listbox"
          aria-autocomplete="list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false)
              inputRef.current?.blur()
              return
            }
            if (shown.length === 0) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => (c + 1) % shown.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => (c - 1 + shown.length) % shown.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              open1(shown[cursor])
            }
          }}
        />
        {!query && (
          <span className="search-shortcut" aria-hidden="true">
            <kbd className="search-kbd">⌘K</kbd>
          </span>
        )}
        {query && (
          <button
            type="button"
            className="search-clear"
            aria-label="清空搜索"
            onClick={() => {
              setQuery('')
              setHits([])
              inputRef.current?.focus()
            }}
          >
            ×
          </button>
        )}
      </div>

      {open && query.trim() !== '' && (
        <div className="search-panel" id="search-listbox" role="listbox" ref={panelRef}>
          {total === 0 ? (
            <div className="search-empty">
              <span className="search-empty-icon" aria-hidden="true">🔍</span>
              <p>未找到与 “{query}” 匹配的内容</p>
              <span className="search-empty-hint">支持搜索课程名称、模块全书、复习笔记与逐字稿标题</span>
            </div>
          ) : (
            <>
              {groups.map((group) => (
                <div key={group.kind} className="search-group">
                  <div className="search-group-head">
                    <span className="search-group-label">{GROUP_LABEL[group.kind]}</span>
                    <span className="search-group-count">{group.all.length}</span>
                  </div>
                  <ul>
                    {group.all.slice(0, PER_GROUP).map((hit) => {
                      const index = shown.indexOf(hit)
                      const isActive = index === cursor
                      return (
                        <li key={`${hit.courseId}/${hit.documentId ?? ''}`}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            className={isActive ? 'search-hit active' : 'search-hit'}
                            onMouseEnter={() => setCursor(index)}
                            onClick={() => open1(hit)}
                          >
                            <span className="search-hit-title">
                              <HighlightMatch text={hit.title} query={query} />
                            </span>
                            {hit.kind !== 'course' && (
                              <span className="search-hit-where">
                                <HighlightMatch text={hit.courseTitle} query={query} />
                              </span>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  {group.all.length > PER_GROUP && (
                    <p className="search-more">另有 {group.all.length - PER_GROUP} 条，继续输入缩小范围</p>
                  )}
                </div>
              ))}
              <div className="search-foot">
                <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
                <span><kbd>↵</kbd> 打开</span>
                <span><kbd>esc</kbd> 关闭</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
