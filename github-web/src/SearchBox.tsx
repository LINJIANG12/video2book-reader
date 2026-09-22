/**
 * 顶栏全局搜索：搜**标题**（课程名 / 册 / 笔记 / 逐字稿）。
 *
 * 只搜标题不搜正文，是因为标题全在已经加载完的课程结构里，所以这个搜索是
 * **零网络、零索引、输入即出结果**的（实现在 `ContentSource.searchTitles`）。
 * 跨库**全文**检索是另一件事，需要构建期倒排索引（docs/00 §11 D3，记在 v2）。
 *
 * 键盘：↓↑ 在结果间移动、Enter 打开、Esc 关闭。这不是可选的锦上添花——
 * 搜索框如果只能鼠标点，键盘用户用它比翻书架还慢。
 */
import { useEffect, useRef, useState } from 'react'
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
  /** 防抖只用来避免每敲一个字就重渲染下拉，查询本身是内存扫描，很快 */
  const timer = useRef<number | undefined>(undefined)

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
    }, 120)
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

  const open1 = (hit: TitleHit | undefined) => {
    if (!hit) return
    onOpenHit(hit)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="search" ref={boxRef}>
      <input
        type="search"
        className="search-input"
        placeholder="搜索课程 / 册 / 笔记 / 逐字稿"
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

      {open && query.trim() !== '' && (
        <div className="search-panel" id="search-listbox" role="listbox">
          {total === 0 ? (
            <p className="search-empty">没有匹配的标题。</p>
          ) : (
            <>
              {groups.map((group) => (
                <div key={group.kind} className="search-group">
                  <div className="search-group-head">
                    {GROUP_LABEL[group.kind]}
                    <span className="search-group-count">{group.all.length}</span>
                  </div>
                  <ul>
                    {group.all.slice(0, PER_GROUP).map((hit) => {
                      const index = shown.indexOf(hit)
                      return (
                        <li key={`${hit.courseId}/${hit.documentId ?? ''}`}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === cursor}
                            className={index === cursor ? 'search-hit active' : 'search-hit'}
                            onMouseEnter={() => setCursor(index)}
                            onClick={() => open1(hit)}
                          >
                            <span className="search-hit-title">{hit.title}</span>
                            {hit.kind !== 'course' && <span className="search-hit-where">{hit.courseTitle}</span>}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  {group.all.length > PER_GROUP && (
                    <p className="search-more">另有 {group.all.length - PER_GROUP} 条，继续输入可缩小范围</p>
                  )}
                </div>
              ))}
              <p className="search-foot">按 ↑↓ 选择、Enter 打开、Esc 关闭</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
