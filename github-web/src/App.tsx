/**
 * 静态阅读站：书架 → 课程（册 / 笔记 / 逐字稿）→ 阅读。
 *
 * 这个 app 的定位（docs/03 §11）：**纯阅读站**。不装载学习插件，没有会话、没有模型、没有划词，
 * 因此也就不存在"要不要显示 AI 入口"的问题 —— 阅读器的产物里根本没有这个概念。
 *
 * 记录策略：**进度只在内存**（关掉即无记录），只有正文缓存落在 IndexedDB，让已读的册离线可读。
 *
 * 内容来源：默认构建期生成的 `/manifest.json`（Cloudflare Pages 走这条，**不碰 api.github.com**）；
 * manifest 不存在时自动回退到运行时取文件树（GitHub Pages 走这条，永远最新）。
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

export function App() {
  const [route, setRoute] = useState<Route>(parseHash)
  /** 进度只在内存：静态站不记录（docs/03 §11.1） */
  const [readVolumes, setReadVolumes] = useState<Record<string, Set<string>>>({})
  /** 阅读页顶栏要显示"在读哪一册"，所以在这里查一次标题（结构已在内存，不额外发请求） */
  const [docTitle, setDocTitle] = useState('')
  const [zip, setZip] = useState<(Progress & { title: string }) | null>(null)
  const apiRef = useRef<ReaderApi | null>(null)

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
      // 两种模式都用它：优先则先读、否则作为失败兜底（见 GitHubSourceOptions.prefer）
      manifestUrl: `${import.meta.env.BASE_URL}manifest.json`,
      prefer: PREFER,
      cache: contentCache,
    })
  }, [])

  // 只在内存里记「这册读过」，用于书架进度（分母用册，见 docs/03 §3）
  const onChapterEnter = useCallback((documentId: string) => {
    const courseId = documentId.split('/')[0]
    setReadVolumes((prev) => {
      const set = new Set(prev[courseId] ?? [])
      if (set.has(documentId)) return prev
      set.add(documentId)
      return { ...prev, [courseId]: set }
    })
  }, [])

  // 阅读页标题：从已加载的结构里取，不额外发请求
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

  /** 搜索命中 → 打开。逐字稿没有阅读视图，所以跳到课程页并**自动展开逐字稿区** */
  const onOpenHit = useCallback(
    (hit: TitleHit) => {
      if (hit.kind === 'course') go({ view: 'course', courseId: hit.courseId, transcripts: false })
      else if (hit.kind === 'subtitle') go({ view: 'course', courseId: hit.courseId, transcripts: true })
      else if (hit.documentId) go({ view: 'reader', documentId: hit.documentId })
    },
    [go],
  )

  /**
   * 下载单个文件。走与在线阅读**完全相同**的取数路径（CDN 回退链 + IndexedDB 缓存），
   * 所以读过的册是零网络的，下载完的内容之后离线也能读。
   */
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
      // 拉取到 total 之后还要压缩与触发保存，再等一拍才清掉进度条
      const wait = window.setInterval(() => {
        if (handle.progress.done >= handle.progress.total) {
          window.clearInterval(wait)
          window.setTimeout(() => setZip(null), 1500)
        }
      }, 400)
    },
    [contentSource, zip],
  )

  const topbar = (
    <header className="topbar">
      <div className="topbar-left">
        {route.view === 'shelf' ? (
          <span className="topbar-brand">课程精读</span>
        ) : (
          <>
            <button type="button" className="topbar-back" onClick={() => go({ view: 'shelf' })}>
              ← 课程精读
            </button>
            {route.view === 'reader' ? (
              <button
                type="button"
                className="topbar-back"
                onClick={() => go({ view: 'course', courseId: route.documentId.split('/')[0], transcripts: false })}
              >
                / {route.documentId.split('/')[0]}
              </button>
            ) : (
              <span className="topbar-crumb">{route.courseId}</span>
            )}
            {route.view === 'reader' && docTitle && <span className="topbar-crumb">{docTitle}</span>}
          </>
        )}
      </div>

      <div className="topbar-right">
        <SearchBox contentSource={contentSource} onOpenHit={onOpenHit} />
        {route.view === 'reader' && (
          <button
            type="button"
            className="topbar-action"
            onClick={() => void downloadDoc({ id: route.documentId, kind: 'volume' }, docTitle)}
          >
            下载本册
          </button>
        )}
      </div>
    </header>
  )

  return (
    <div className="app-root">
      {topbar}
      {zip && (
        <div className="progress-bar" role="status">
          正在打包《{zip.title}》 {zip.done}/{zip.total}
        </div>
      )}
      <main className="app-main">
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
  onOpen,
  onDownload,
  onZip,
  zip,
}: {
  contentSource: ContentSource
  courseId: string
  transcriptsOpen: boolean
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

  if (state.phase === 'loading') return <div className="reader-status">正在读取课程…</div>
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

  return (
    <div className="course">
      <header className="course-head">
        <div>
          <h1>{course.title}</h1>
          {course.direction && <p className="course-direction">{course.direction}</p>}
        </div>
        <button type="button" className="topbar-action" disabled={Boolean(zipBusy)} onClick={() => onZip(course)}>
          {zipBusy ? `打包中 ${zip.done}/${zip.total}` : '下载整门课'}
        </button>
      </header>

      {/* 模块与笔记**并行两栏**（原本是纵向串行，一门课有多少笔记要滚到底才知道） */}
      <div className="course-cols">
        <DocList title="模块全书" hint="按课堂讲授顺序，读起来是连贯的教材" docs={pick('volume')} onOpen={onOpen} />
        <DocList title="复习笔记" hint="跨章节的概念对比与速查" docs={pick('note')} onOpen={onOpen} />
      </div>

      {/* 逐字稿**不并行**：它是附属资源，另起一段放在下面，默认收起 */}
      <TranscriptList docs={pick('subtitle')} defaultOpen={transcriptsOpen} onDownload={onDownload} />
    </div>
  )
}

function DocList({
  title,
  hint,
  docs,
  onOpen,
}: {
  title: string
  hint: string
  docs: DocumentSummary[]
  onOpen: (id: string) => void
}) {
  return (
    <section className="doc-list">
      <h2>
        {title}
        <span className="doc-count">{docs.length}</span>
      </h2>
      <p className="doc-hint">{hint}</p>
      {docs.length === 0 ? (
        <p className="doc-hint">这门课没有这一类内容。</p>
      ) : (
        <ol>
          {docs.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onOpen(d.id)}>
                <span className="doc-index">{String(d.originIndex).padStart(2, '0')}</span>
                <span className="doc-title">{d.title}</span>
                <span className="doc-size">{Math.round(d.size / 1024)} KB</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/**
 * 逐字稿：可展开的紧凑列表，每行可单独下载。
 *
 * **不做阅读视图**（已定案）：它是 `.txt`，走 Markdown 管线没有意义，而另做一套纯文本排版
 * 也不值当。逐字稿的用途是"核对讲师原话"，所以提供下载即可——需要细看时用本地编辑器。
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

  // 从搜索跳过来时（hash 带 ?t）要自动展开
  useEffect(() => setOpen(defaultOpen), [defaultOpen])

  if (docs.length === 0) return null

  return (
    <section className="transcripts">
      <button type="button" className="transcripts-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="transcripts-twisty" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="transcripts-title">逐字稿</span>
        <span className="doc-count">{docs.length}</span>
        <span className="doc-hint">流水线保留的原始语料 · 核对讲师原话用</span>
      </button>

      {open && (
        <ul className="transcripts-list">
          {docs.map((d) => (
            <li key={d.id}>
              <span className="doc-index">{String(d.originIndex).padStart(2, '0')}</span>
              <span className="transcripts-name">{d.title}</span>
              <span className="doc-size">{Math.round(d.size / 1024)} KB</span>
              <button
                type="button"
                className="transcripts-dl"
                aria-label={`下载逐字稿：${d.title}`}
                onClick={() => void onDownload(d, d.title)}
              >
                ⤓
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
