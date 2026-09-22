/**
 * 书架：16 门课的卡片列表。
 *
 * 进度分母用**册**而不是章：总册数从文件树/ manifest 直接可得，而总章数必须下载并解析全部册
 * （最重的课 25 册约数 MB），与「先拉结构、不解析正文」和「首屏 ≤ 2 秒」直接冲突（docs/03 §3）。
 * 展开到某一册时再改显示「已读章 / 本册章数」——那时正文已在内存，分母是已知的。
 */
import { useEffect, useState } from 'react'
import type { CourseSummary, ContentSource } from '../types.ts'

export type BookshelfProps = {
  contentSource: ContentSource
  onOpen: (documentId: string) => void
  /** 各课的已读册数（由调用方提供；阅读器本身不存任何东西） */
  progress?: Record<string, number>
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; courses: CourseSummary[] }
  | { phase: 'error'; message: string }

export function Bookshelf({ contentSource, onOpen, progress = {} }: BookshelfProps) {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    contentSource
      .listCourses()
      .then((courses) => {
        if (!cancelled) setState({ phase: 'ready', courses })
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ phase: 'error', message: e.message })
      })
    return () => {
      cancelled = true
    }
  }, [contentSource])

  if (state.phase === 'loading') return <div className="reader-status">正在读取书架…</div>
  if (state.phase === 'error') {
    return (
      <div className="reader-status">
        <p>书架还没出来。</p>
        <p className="detail">{state.message}</p>
      </div>
    )
  }
  if (state.courses.length === 0) {
    return <div className="reader-status">还没有内容。</div>
  }

  return (
    <div className="shelf">
      <header className="shelf-head">
        <h1>课程书架</h1>
        <p>
          {state.courses.length} 门课 · {state.courses.reduce((n, c) => n + c.volumeCount, 0)} 册模块全书 ·{' '}
          {state.courses.reduce((n, c) => n + c.noteCount, 0)} 篇复习笔记
        </p>
      </header>
      <ul className="shelf-list">
        {state.courses.map((c) => {
          const read = progress[c.id] ?? 0
          const pct = c.volumeCount > 0 ? Math.round((read / c.volumeCount) * 100) : 0
          return (
            <li key={c.id} className="shelf-card">
              <button type="button" className="shelf-open" onClick={() => onOpen(c.id)}>
                <span className="shelf-title">{c.title}</span>
                {c.direction && <span className="shelf-direction">{c.direction}</span>}
                <span className="shelf-meta">
                  {c.volumeCount} 册 · {c.noteCount} 笔记
                  {c.subtitleCount > 0 && ` · ${c.subtitleCount} 逐字稿`}
                </span>
                <span className="shelf-progress" aria-label={`已读 ${read} / ${c.volumeCount} 册`}>
                  <span className="shelf-bar" style={{ width: `${pct}%` }} />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
