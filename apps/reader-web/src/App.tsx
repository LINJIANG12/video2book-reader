/**
 * 静态阅读站：书架 → 课程（册列表）→ 阅读。
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
  type ReaderApi,
} from '@app/reader'
import { contentCache } from './idb-cache.ts'

const REPO = (import.meta.env.VITE_COURSES_REPO as string | undefined) ?? 'LINJIANG12/video2book-courses'
const REF = (import.meta.env.VITE_COURSES_REF as string | undefined) ?? 'main'

const [owner, repo] = REPO.split('/')

type Route = { view: 'shelf' } | { view: 'course'; courseId: string } | { view: 'reader'; documentId: string }

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '')
  const [kind, ...rest] = h.split('/')
  const value = decodeURIComponent(rest.join('/'))
  if (kind === 'c' && value) return { view: 'course', courseId: value }
  if (kind === 'v' && value) return { view: 'reader', documentId: value }
  return { view: 'shelf' }
}

function hrefFor(route: Route): string {
  if (route.view === 'course') return `#/c/${encodeURIComponent(route.courseId)}`
  if (route.view === 'reader') return `#/v/${encodeURIComponent(route.documentId)}`
  return '#/'
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash)
  /** 进度只在内存：静态站不记录（docs/03 §11.1） */
  const [readVolumes, setReadVolumes] = useState<Record<string, Set<string>>>({})
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
      // 存在则用它（静态站），404 会自动回退到运行时取树（见 github-source 的说明）
      manifestUrl: `${import.meta.env.BASE_URL}manifest.json`,
      cache: contentCache,
    })
  }, [])

  // 只在内存里记「这册读过」，用于书架进度（分母用册，见 docs/03 §3）
  const onChapterEnter = useCallback(
    (documentId: string) => {
      const courseId = documentId.split('/')[0]
      setReadVolumes((prev) => {
        const set = new Set(prev[courseId] ?? [])
        if (set.has(documentId)) return prev
        set.add(documentId)
        return { ...prev, [courseId]: set }
      })
    },
    [],
  )

  if (route.view === 'reader') {
    return (
      <div className="reader-root">
        <TopBar onHome={() => go({ view: 'shelf' })} label="返回书架" />
        <Reader
          contentSource={contentSource}
          documentId={route.documentId}
          apiRef={apiRef}
          events={{ onChapterEnter }}
        />
      </div>
    )
  }

  if (route.view === 'course') {
    return (
      <div className="reader-root">
        <TopBar onHome={() => go({ view: 'shelf' })} label="返回书架" />
        <CourseView
          contentSource={contentSource}
          courseId={route.courseId}
          onOpen={(documentId) => go({ view: 'reader', documentId })}
        />
      </div>
    )
  }

  return (
    <div className="reader-root">
      <Bookshelf
        contentSource={contentSource}
        onOpen={(courseId) => go({ view: 'course', courseId })}
        progress={Object.fromEntries(Object.entries(readVolumes).map(([k, v]) => [k, v.size]))}
      />
    </div>
  )
}

function TopBar({ onHome, label }: { onHome: () => void; label: string }) {
  return (
    <div className="topbar">
      <button type="button" onClick={onHome} className="topbar-back">
        ← {label}
      </button>
    </div>
  )
}

function CourseView({
  contentSource,
  courseId,
  onOpen,
}: {
  contentSource: ContentSource
  courseId: string
  onOpen: (documentId: string) => void
}) {
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'ready'; course: CourseDetail } | { phase: 'error'; message: string }>({
    phase: 'loading',
  })

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
  if (state.phase === 'error')
    return (
      <div className="reader-status">
        <p>这门课没读出来。</p>
        <p className="detail">{state.message}</p>
      </div>
    )

  const { course } = state
  const volumes = course.documents.filter((d) => d.kind === 'volume')
  const notes = course.documents.filter((d) => d.kind === 'note')

  return (
    <div className="course">
      <header className="course-head">
        <h1>{course.title}</h1>
        {course.direction && <p className="course-direction">{course.direction}</p>}
        <p className="course-meta">
          {volumes.length} 册模块全书 · {notes.length} 篇复习笔记
          {course.subtitleCount > 0 && ` · ${course.subtitleCount} 份逐字稿（v1 未开放阅读）`}
        </p>
      </header>

      <DocList title="模块全书" hint="按课堂讲授顺序，读起来是连贯的教材" docs={volumes} onOpen={onOpen} />
      {notes.length > 0 && <DocList title="复习笔记" hint="跨章节的概念对比与速查" docs={notes} onOpen={onOpen} />}
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
  docs: { id: string; title: string; originIndex: number; size: number }[]
  onOpen: (id: string) => void
}) {
  return (
    <section className="doc-list">
      <h2>
        {title} <span className="doc-hint">{hint}</span>
      </h2>
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
    </section>
  )
}
