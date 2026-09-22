/**
 * 静态阅读站：书架 → 课程（册 / 笔记 / 逐字稿）→ 阅读。
 *
 * 定位：纯阅读站。零 AI、零划词、零记录（进度只在内存，关闭即清空）。
 *
 * 增强特性：
 *   · 主题明暗切换（System / Light / Dark），本地持久化
 *   · 顶栏微阅读进度条与百分比实时显示
 *   · 课程详情页显示已读状态穿透与单册快速下载
 *   · 逐字稿响应式排版与即时过滤
 *   · 丝滑的 ZIP 打包动态进度条
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bookshelf,
  Reader,
  createGitHubSource,
  type ContentSource,
  type CourseDetail,
  type DocumentSummary,
  type ReaderApi,
  type TitleHit,
} from '@app/reader'
import { contentCache } from './idb-cache.ts'
import { SearchBox } from './SearchBox.tsx'
import { downloadCourseZip, fileNameOf, saveTextFile, type Progress } from './download.ts'

const REPO = (import.meta.env.VITE_COURSES_REPO as string | undefined) ?? 'LINJIANG12/video2book-courses'
const REF = (import.meta.env.VITE_COURSES_REF as string | undefined) ?? 'main'
/** 结构优先从哪来。GitHub Pages 用 runtime（实时），Cloudflare 用 manifest（不碰 api.github.com）。两者互为兜底 */
const PREFER = (import.meta.env.VITE_CONTENT_PREFER as string | undefined) === 'runtime' ? 'runtime' : 'manifest'

const [owner, repo] = REPO.split('/')

type Route =
  | { view: 'shelf' }
  | { view: 'course'; courseId: string; transcripts: boolean }
  | { view: 'reader'; documentId: string }

function parseHash(): Route {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?')
  const [kind, ...rest] = path.split('/')
  const value = decodeURIComponent(rest.join('/'))
  if (kind === 'c' && value) return { view: 'course', courseId: value, transcripts: new URLSearchParams(qs ?? '').has('t') }
  if (kind === 'v' && value) return { view: 'reader', documentId: value }
  return { view: 'shelf' }
}

function hrefFor(route: Route): string {
  if (route.view === 'course') return `#/c/${encodeURIComponent(route.courseId)}${route.transcripts ? '?t' : ''}`
  if (route.view === 'reader') return `#/v/${encodeURIComponent(route.documentId)}`
  return '#/'
}

type Theme = 'light' | 'dark' | 'system'
type ReadingWidth = 'standard' | 'wide'

function getInitialTheme(): Theme {
  const saved = localStorage.getItem('cr-theme') as Theme | null
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  return 'system'
}

function getInitialWidth(): ReadingWidth {
  return localStorage.getItem('cr-width') === 'wide' ? 'wide' : 'standard'
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash)
  /** 进度只在内存：静态站不落盘（docs/03 §11.1） */
  const [readVolumes, setReadVolumes] = useState<Record<string, Set<string>>>({})
  /** 阅读页顶栏要显示"在读哪一册"，从内存结构直接查 */
  const [docTitle, setDocTitle] = useState('')
  const [zip, setZip] = useState<(Progress & { title: string }) | null>(null)
  const [readPercent, setReadPercent] = useState(0)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [readingWidth, setReadingWidth] = useState<ReadingWidth>(getInitialWidth)
  const apiRef = useRef<ReaderApi | null>(null)

  const toggleWidth = useCallback(() => {
    setReadingWidth((prev) => {
      const next = prev === 'wide' ? 'standard' : 'wide'
      localStorage.setItem('cr-width', next)
      return next
    })
  }, [])

  // 主题切换响应
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') {
      root.removeAttribute('data-theme')
      localStorage.setItem('cr-theme', 'system')
    } else {
      root.setAttribute('data-theme', theme)
      localStorage.setItem('cr-theme', theme)
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      if (prev === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        return isDark ? 'light' : 'dark'
      }
      return prev === 'dark' ? 'light' : 'dark'
    })
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = useCallback((next: Route) => {
    location.hash = hrefFor(next)
  }, [])

  const contentSource: ContentSource = useMemo(() => {
    if (!owner || !repo) throw new Error(`VITE_COURSES_REPO 格式应为 owner/name，收到：${REPO}`)
    return createGitHubSource({
      owner,
      repo,
      ref: REF,
      manifestUrl: `${import.meta.env.BASE_URL}manifest.json`,
      prefer: PREFER,
      cache: contentCache,
    })
  }, [])

  // 只在内存里记「这册读过」，用于书架进度与课程页高亮
  const onChapterEnter = useCallback((documentId: string) => {
    const courseId = documentId.split('/')[0]
    setReadVolumes((prev) => {
      const set = new Set(prev[courseId] ?? [])
      if (set.has(documentId)) return prev
      set.add(documentId)
      return { ...prev, [courseId]: set }
    })
  }, [])

  // 监听正文滚动，计算阅读进度百分比
  useEffect(() => {
    if (route.view !== 'reader') {
      setReadPercent(0)
      return
    }
    let cleanup: (() => void) | undefined
    const timer = window.setInterval(() => {
      const body = document.querySelector<HTMLElement>('.reader-body')
      if (!body) return
      window.clearInterval(timer)

      const handleScroll = () => {
        const max = body.scrollHeight - body.clientHeight
        if (max > 0) {
          const pct = Math.min(100, Math.max(0, Math.round((body.scrollTop / max) * 100)))
          setReadPercent(pct)
        }
      }
      body.addEventListener('scroll', handleScroll, { passive: true })
      handleScroll()
      cleanup = () => body.removeEventListener('scroll', handleScroll)
    }, 100)

    return () => {
      window.clearInterval(timer)
      cleanup?.()
    }
  }, [route])

  // 阅读页标题查询
  useEffect(() => {
    if (route.view !== 'reader') {
      setDocTitle('')
      return
    }
    const courseId = route.documentId.split('/')[0]
    const documentId = route.documentId
    let cancelled = false
    contentSource
      .loadCourse(courseId)
      .then((c) => {
        if (!cancelled) setDocTitle(c.documents.find((d) => d.id === documentId)?.title ?? fileNameOf(documentId))
      })
      .catch(() => {
        if (!cancelled) setDocTitle(fileNameOf(documentId))
      })
    return () => {
      cancelled = true
    }
  }, [route, contentSource])

  const onOpenHit = useCallback(
    (hit: TitleHit) => {
      if (hit.kind === 'course') go({ view: 'course', courseId: hit.courseId, transcripts: false })
      else if (hit.kind === 'subtitle') go({ view: 'course', courseId: hit.courseId, transcripts: true })
      else if (hit.documentId) go({ view: 'reader', documentId: hit.documentId })
    },
    [go],
  )

  const downloadDoc = useCallback(
    async (doc: Pick<DocumentSummary, 'id' | 'kind'> | { id: string; kind: string }, title: string) => {
      const text = await contentSource.loadDocument(doc.id)
      const base = title || fileNameOf(doc.id).replace(/\.(md|txt)$/, '')
      if (doc.kind === 'subtitle') saveTextFile(`${base}.txt`, text, 'text/plain;charset=utf-8')
      else saveTextFile(`${base}.md`, text)
    },
    [contentSource],
  )

  const startZip = useCallback(
    (course: CourseDetail) => {
      if (zip) return
      const handle = downloadCourseZip(course, contentSource, (p) => setZip({ ...p, title: course.title }))
      setZip({ ...handle.progress, title: course.title })
      const wait = window.setInterval(() => {
        if (handle.progress.done >= handle.progress.total) {
          window.clearInterval(wait)
          window.setTimeout(() => setZip(null), 1600)
        }
      }, 300)
    },
    [contentSource, zip],
  )

  const topbar = (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="topbar-brand" onClick={() => go({ view: 'shelf' })} aria-label="回到书架">
          <span className="topbar-logo" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </span>
          <span className="topbar-brand-name">课程精读</span>
        </button>

        {route.view !== 'shelf' && (
          <nav className="topbar-crumbs" aria-label="面包屑导航">
            <span className="topbar-sep" aria-hidden="true">/</span>
            {route.view === 'reader' ? (
              <>
                <button
                  type="button"
                  className="topbar-crumb-btn"
                  title={route.documentId.split('/')[0]}
                  onClick={() => go({ view: 'course', courseId: route.documentId.split('/')[0], transcripts: false })}
                >
                  {route.documentId.split('/')[0]}
                </button>
                <span className="topbar-sep" aria-hidden="true">/</span>
                <span className="topbar-crumb-active" title={docTitle || fileNameOf(route.documentId)}>
                  {docTitle || fileNameOf(route.documentId)}
                </span>
                <span className="topbar-read-pill" aria-label={`阅读进度 ${readPercent}%`}>
                  {readPercent}%
                </span>
              </>
            ) : (
              <span className="topbar-crumb-active" title={route.courseId}>
                {route.courseId}
              </span>
            )}
          </nav>
        )}
      </div>

      <div className="topbar-right">
        <SearchBox contentSource={contentSource} onOpenHit={onOpenHit} />

        <button
          type="button"
          className="topbar-icon-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换为亮色模式' : '切换为暗色模式'}
          aria-label="切换主题颜色"
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        {route.view === 'reader' && (
          <button
            type="button"
            className={`topbar-icon-btn ${readingWidth === 'wide' ? 'active' : ''}`}
            onClick={toggleWidth}
            title={readingWidth === 'wide' ? '切换为标准舒适阅读宽' : '切换为超宽满屏排版'}
            aria-label="切换排版宽度"
          >
            {readingWidth === 'wide' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
        )}

        {route.view === 'reader' && (
          <button
            type="button"
            className="topbar-action-btn"
            onClick={() => void downloadDoc({ id: route.documentId, kind: 'volume' }, docTitle)}
            title="下载当前册原始 Markdown"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>下载本册</span>
          </button>
        )}
      </div>
    </header>
  )

  return (
    <div className="app-root" data-reading-width={readingWidth}>
      {topbar}
      {route.view === 'reader' && (
        <div className="reading-progress-track" aria-hidden="true">
          <div className="reading-progress-fill" style={{ width: `${readPercent}%` }} />
        </div>
      )}
      {zip && (
        <div className="zip-progress-banner" role="status">
          <div className="zip-progress-info">
            <span className="zip-progress-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              正在打包《{zip.title}》
            </span>
            <span className="zip-progress-num">
              {zip.done}/{zip.total}
            </span>
          </div>
          <div className="zip-progress-track">
            <div
              className="zip-progress-fill"
              style={{ width: `${Math.min(100, Math.round((zip.done / zip.total) * 100))}%` }}
            />
          </div>
        </div>
      )}
      <main className="app-main" data-reading-width={readingWidth}>
        {route.view === 'shelf' && (
          <Bookshelf
            contentSource={contentSource}
            onOpen={(courseId) => go({ view: 'course', courseId, transcripts: false })}
            progress={Object.fromEntries(Object.entries(readVolumes).map(([k, v]) => [k, v.size]))}
          />
        )}
        {route.view === 'course' && (
          <CourseView
            contentSource={contentSource}
            courseId={route.courseId}
            transcriptsOpen={route.transcripts}
            readSet={readVolumes[route.courseId]}
            onOpen={(documentId) => go({ view: 'reader', documentId })}
            onDownload={downloadDoc}
            onZip={startZip}
            zip={zip}
          />
        )}
        {route.view === 'reader' && (
          <Reader contentSource={contentSource} documentId={route.documentId} apiRef={apiRef} events={{ onChapterEnter }} />
        )}
      </main>
    </div>
  )
}

function CourseView({
  contentSource,
  courseId,
  transcriptsOpen,
  readSet,
  onOpen,
  onDownload,
  onZip,
  zip,
}: {
  contentSource: ContentSource
  courseId: string
  transcriptsOpen: boolean
  readSet?: Set<string>
  onOpen: (documentId: string) => void
  onDownload: (doc: DocumentSummary, title: string) => Promise<void>
  onZip: (course: CourseDetail) => void
  zip: (Progress & { title: string }) | null
}) {
  const [state, setState] = useState<
    { phase: 'loading' } | { phase: 'ready'; course: CourseDetail } | { phase: 'error'; message: string }
  >({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    contentSource
      .loadCourse(courseId)
      .then((course) => !cancelled && setState({ phase: 'ready', course }))
      .catch((e: Error) => !cancelled && setState({ phase: 'error', message: e.message }))
    return () => {
      cancelled = true
    }
  }, [contentSource, courseId])

  if (state.phase === 'loading') {
    return (
      <div className="course-loading">
        <div className="loading-spinner" aria-hidden="true" />
        <p>正在读取课程结构与文件清单…</p>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className="reader-status reader-status-error">
        <p>这门课没读出来。</p>
        <p className="detail">{state.message}</p>
      </div>
    )
  }

  const { course } = state
  const pick = (kind: DocumentSummary['kind']) => course.documents.filter((d) => d.kind === kind)
  const zipBusy = zip && zip.title === course.title
  const volumes = pick('volume')
  const notes = pick('note')
  const subtitles = pick('subtitle')
  const totalMb = (course.documents.reduce((n, d) => n + d.size, 0) / 1024 / 1024).toFixed(1)
  const readCount = volumes.filter((v) => readSet?.has(v.id)).length

  return (
    <div className="course">
      <header className="course-hero">
        <div className="course-hero-content">
          <div className="course-tags">
            {course.direction && <span className="course-direction-pill">{course.direction}</span>}
            <span className="course-meta-pill">{volumes.length} 册全书</span>
            <span className="course-meta-pill">{notes.length} 篇笔记</span>
            {subtitles.length > 0 && <span className="course-meta-pill">{subtitles.length} 份逐字稿</span>}
            <span className="course-meta-pill">{totalMb} MB</span>
          </div>
          <h1 className="course-hero-title">{course.title}</h1>
          {readCount > 0 && (
            <p className="course-read-stat">
              已研读本课 {readCount}/{volumes.length} 册 ({Math.round((readCount / volumes.length) * 100)}%)
            </p>
          )}
        </div>

        <button
          type="button"
          className="course-zip-btn"
          disabled={Boolean(zipBusy)}
          onClick={() => onZip(course)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {zipBusy ? `打包中 ${zip.done}/${zip.total}` : '打包下载整门课'}
        </button>
      </header>

      {/* 模块全书与复习笔记并行两栏 */}
      <div className="course-cols">
        <DocList
          title="模块全书"
          hint="按课堂讲授顺序，读起来是连贯的教材"
          docs={volumes}
          readSet={readSet}
          onOpen={onOpen}
          onDownload={onDownload}
        />
        <DocList
          title="复习笔记"
          hint="跨章节概念提炼与对比速查"
          docs={notes}
          onOpen={onOpen}
          onDownload={onDownload}
        />
      </div>

      {/* 逐字稿：紧凑网格，支持即时过滤与下载 */}
      <TranscriptList docs={subtitles} defaultOpen={transcriptsOpen} onDownload={onDownload} />
    </div>
  )
}

function DocList({
  title,
  hint,
  docs,
  readSet,
  onOpen,
  onDownload,
}: {
  title: string
  hint: string
  docs: DocumentSummary[]
  readSet?: Set<string>
  onOpen: (id: string) => void
  onDownload: (doc: DocumentSummary, title: string) => Promise<void>
}) {
  return (
    <section className="doc-list">
      <div className="doc-list-head">
        <h2>
          {title}
          <span className="doc-count">{docs.length}</span>
        </h2>
        <p className="doc-hint">{hint}</p>
      </div>

      {docs.length === 0 ? (
        <div className="doc-empty">这门课没有这一类内容。</div>
      ) : (
        <ol className="doc-ol">
          {docs.map((d) => {
            const isRead = readSet?.has(d.id)
            return (
              <li key={d.id} className={isRead ? 'doc-li is-read' : 'doc-li'}>
                <div className="doc-row" onClick={() => onOpen(d.id)} role="button" tabIndex={0} onKeyDown={(e) => {
                  if (e.key === 'Enter') onOpen(d.id)
                }}>
                  <span className="doc-index">{String(d.originIndex).padStart(2, '0')}</span>
                  <div className="doc-main">
                    <span className="doc-title">{d.title}</span>
                  </div>
                  {isRead && <span className="doc-read-badge">已读</span>}
                  <span className="doc-size">{Math.round(d.size / 1024)} KB</span>
                  <button
                    type="button"
                    className="doc-quick-dl"
                    title={`下载 ${d.title}.md`}
                    aria-label={`下载 ${d.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onDownload(d, d.title)
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/**
 * 逐字稿：可折叠网格布局，支持即时过滤搜索与单行极速下载。
 */
function TranscriptList({
  docs,
  defaultOpen,
  onDownload,
}: {
  docs: DocumentSummary[]
  defaultOpen: boolean
  onDownload: (doc: DocumentSummary, title: string) => Promise<void>
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [filter, setFilter] = useState('')

  useEffect(() => setOpen(defaultOpen), [defaultOpen])

  if (docs.length === 0) return null

  const filtered = filter.trim()
    ? docs.filter((d) => d.title.toLowerCase().includes(filter.trim().toLowerCase()))
    : docs

  return (
    <section className="transcripts">
      <div className="transcripts-bar">
        <button
          type="button"
          className="transcripts-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="transcripts-twisty" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="transcripts-title">原始逐字稿语料</span>
          <span className="doc-count">{docs.length}</span>
          <span className="doc-hint">核对讲师原话 · 支持单份下载</span>
        </button>

        {open && docs.length > 8 && (
          <div className="transcripts-search-wrap">
            <input
              type="search"
              className="transcripts-filter-input"
              placeholder="过滤逐字稿标题..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        )}
      </div>

      {open && (
        <>
          {filtered.length === 0 ? (
            <p className="doc-empty">没有匹配的逐字稿。</p>
          ) : (
            <ul className="transcripts-grid">
              {filtered.map((d) => (
                <li key={d.id} className="transcripts-item">
                  <span className="doc-index">{String(d.originIndex).padStart(2, '0')}</span>
                  <span className="transcripts-name" title={d.title}>
                    {d.title}
                  </span>
                  <span className="doc-size">{Math.round(d.size / 1024)} KB</span>
                  <button
                    type="button"
                    className="transcripts-dl-btn"
                    aria-label={`下载逐字稿：${d.title}`}
                    title="下载 .txt 逐字稿"
                    onClick={() => void onDownload(d, d.title)}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
