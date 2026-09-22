/**
 * 书架：16 门课的**索引式**列表。
 *
 * ## 为什么不是卡片网格
 *
 * 早先是每门课一张圆角卡、meta 写成 `25 册 · 17 笔记 · 87 逐字稿`。那有两个问题：
 *   1. **中点分隔的串无法比较**——想找"册数最多的那门课"得把 16 个串逐个读完
 *   2. 16 张一模一样的卡片把信息压成同一种形状，层次完全丢失
 *
 * 现在是单栏索引：左边一条竖线是阅读进度（复用正文 callout 的视觉语法），
 * 序号是策展顺序（**真实序列**，所以编号成立），计数各自成列、数字对齐——
 * 于是"哪门课最厚"一眼可见。
 *
 * 进度分母用**册**而不是章：总册数从文件树直接可得，而总章数必须下载并解析全部册
 * （最重的课 25 册约数 MB），与「先拉结构、不解析正文」和「首屏 ≤ 2 秒」直接冲突（docs/03 §3）。
 */
import { useEffect, useState } from 'react'
import type { CourseSummary, ContentSource } from '../types.ts'

export type BookshelfProps = {
  contentSource: ContentSource
  onOpen: (courseId: string) => void
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
      <div className="reader-status reader-status-error">
        <p>书架还没出来。</p>
        <p className="detail">{state.message}</p>
      </div>
    )
  }
  if (state.courses.length === 0) {
    return <div className="reader-status">还没有内容。</div>
  }

  const sum = (pick: (c: CourseSummary) => number) => state.courses.reduce((n, c) => n + pick(c), 0)

  return (
    <div className="shelf">
      <header className="shelf-head">
        <h1>课程书架</h1>
        <p className="shelf-stats">
          {state.courses.length} 门课 · {sum((c) => c.volumeCount)} 册模块全书 · {sum((c) => c.noteCount)} 篇复习笔记 ·{' '}
          {sum((c) => c.subtitleCount)} 份逐字稿
        </p>
      </header>

      <div className="shelf-table">
        {/* 表头只出现一次：计数的含义由此确定，之后各行只给数字 */}
        <div className="shelf-columns" aria-hidden="true">
          <span />
          <span />
          <span>课程</span>
          <span className="shelf-num">册</span>
          <span className="shelf-num">笔记</span>
          <span className="shelf-num">逐字稿</span>
          <span className="shelf-num">已读</span>
        </div>

        <ul className="shelf-list">
          {state.courses.map((c, i) => {
            const read = progress[c.id] ?? 0
            const pct = c.volumeCount > 0 ? Math.min(100, Math.round((read / c.volumeCount) * 100)) : 0
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="shelf-open"
                  onClick={() => onOpen(c.id)}
                  aria-label={`${c.title}，${c.volumeCount} 册，已读 ${read} 册`}
                >
                  <span className="shelf-rail" aria-hidden="true">
                    <span className="shelf-rail-fill" style={{ height: `${pct}%` }} />
                  </span>
                  <span className="shelf-ord">{String(i + 1).padStart(2, '0')}</span>
                  <span className="shelf-name">
                    <span className="shelf-title">{c.title}</span>
                    {c.direction && <span className="shelf-direction">{c.direction}</span>}
                  </span>
                  <span className="shelf-num">{c.volumeCount}</span>
                  <span className="shelf-num">{c.noteCount}</span>
                  <span className="shelf-num shelf-dim">{c.subtitleCount || '—'}</span>
                  <span className="shelf-num shelf-dim">
                    {read}/{c.volumeCount}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
