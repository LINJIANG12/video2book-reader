/**
 * 书架：支持多级分类导航、按主分类分组和课程索引。
 *
 * 分类数据来自 catalog/manifest；每门课程在当前视图只出现一次，交叉分类
 * 只用于筛选和导航，不重复累计课程、册数或笔记数。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  buildCategoryTree,
  categoryContainsCourse,
  countCategory,
  groupCourses,
  type CategoryNode,
} from '../content/category-tree.ts'
import type { CourseCatalogCategory, CourseSummary, ContentSource } from '../types.ts'

export type BookshelfProps = {
  contentSource: ContentSource
  onOpen: (courseId: string) => void
  /** 各课的已读册数（由调用方提供；阅读器本身不存任何东西） */
  progress?: Record<string, number>
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; courses: CourseSummary[]; categories: CourseCatalogCategory[] }
  | { phase: 'error'; message: string }

export function Bookshelf({ contentSource, onOpen, progress = {} }: BookshelfProps) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    Promise.all([contentSource.listCourses(), contentSource.listCategories().catch(() => [])])
      .then(([courses, categories]) => {
        if (!cancelled) setState({ phase: 'ready', courses, categories })
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ phase: 'error', message: e.message })
      })
    return () => {
      cancelled = true
    }
  }, [contentSource])

  const courses = state.phase === 'ready' ? state.courses : []
  const categories = state.phase === 'ready' ? state.categories : []
  const tree = useMemo(() => buildCategoryTree(categories), [categories])
  const groups = useMemo(
    () => groupCourses(courses, selectedCategoryId, categories),
    [courses, selectedCategoryId, categories],
  )
  const visibleCourses = useMemo(
    () => courses.filter((course) => categoryContainsCourse(course, selectedCategoryId)),
    [courses, selectedCategoryId],
  )
  const courseOrder = useMemo(() => new Map(courses.map((course, index) => [course.id, index])), [courses])

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

  const sum = (pick: (course: CourseSummary) => number) => visibleCourses.reduce((n, course) => n + pick(course), 0)
  const selectedName = selectedCategoryId
    ? categories.find((category) => category.id === selectedCategoryId)?.name ?? selectedCategoryId
    : '全部课程'

  return (
    <div className="shelf">
      <div className={`shelf-layout${categories.length === 0 ? ' shelf-no-nav' : ''}`}>
        {categories.length > 0 && (
          <CategoryNav
            courses={courses}
            tree={tree}
            selectedCategoryId={selectedCategoryId}
            onSelect={setSelectedCategoryId}
          />
        )}

        <main className="shelf-main">
          <header className="shelf-head">
            <h1>{selectedName}</h1>
            <p className="shelf-stats">
              {visibleCourses.length} 门课 · {sum((course) => course.volumeCount)} 册模块全书 ·{' '}
              {sum((course) => course.noteCount)} 篇复习笔记 · {sum((course) => course.subtitleCount)} 份逐字稿
            </p>
          </header>

          <div className="shelf-table">
            <div className="shelf-columns" aria-hidden="true">
              <span />
              <span />
              <span>课程</span>
              <span className="shelf-num">册</span>
              <span className="shelf-num">笔记</span>
              <span className="shelf-num">逐字稿</span>
              <span className="shelf-num">已读</span>
            </div>

            {groups.length === 0 ? (
              <div className="shelf-filter-empty">这个分类下暂时没有课程。</div>
            ) : (
              groups.map((group) => (
                <section className="shelf-group" key={group.id}>
                  {categories.length > 0 && (
                    <h2 className="shelf-group-head">
                      <span>{group.name}</span>
                      <span className="shelf-group-count">{group.courses.length} 门</span>
                    </h2>
                  )}
                  <ul className="shelf-list">
                    {group.courses.map((course) => {
                      const read = progress[course.id] ?? 0
                      const pct = course.volumeCount > 0 ? Math.min(100, Math.round((read / course.volumeCount) * 100)) : 0
                      const order = (courseOrder.get(course.id) ?? 0) + 1
                      return (
                        <li key={course.id}>
                          <button
                            type="button"
                            className="shelf-open"
                            onClick={() => onOpen(course.id)}
                            aria-label={`${course.title}，${course.volumeCount} 册，已读 ${read} 册`}
                          >
                            <span className="shelf-rail" aria-hidden="true">
                              <span className="shelf-rail-fill" style={{ height: `${pct}%` }} />
                            </span>
                            <span className="shelf-ord">{String(order).padStart(2, '0')}</span>
                            <span className="shelf-name">
                              <span className="shelf-title">{course.title}</span>
                              {course.direction && <span className="shelf-direction">{course.direction}</span>}
                            </span>
                            <span className="shelf-num">{course.volumeCount}</span>
                            <span className="shelf-num">{course.noteCount}</span>
                            <span className="shelf-num shelf-dim">{course.subtitleCount || '—'}</span>
                            <span className="shelf-num shelf-dim">
                              {read}/{course.volumeCount}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

function CategoryNav({
  courses,
  tree,
  selectedCategoryId,
  onSelect,
}: {
  courses: CourseSummary[]
  tree: CategoryNode[]
  selectedCategoryId: string | null
  onSelect: (id: string | null) => void
}) {
  return (
    <aside className="shelf-nav">
      <div className="shelf-nav-title">分类导航</div>
      <button
        type="button"
        className={`shelf-nav-item shelf-nav-all${selectedCategoryId === null ? ' is-active' : ''}`}
        onClick={() => onSelect(null)}
        aria-current={selectedCategoryId === null ? 'page' : undefined}
      >
        <span>全部课程</span>
        <span className="shelf-nav-count">{courses.length}</span>
      </button>
      <ul className="shelf-nav-tree">
        {tree.map((node) => (
          <CategoryBranch
            key={node.id}
            node={node}
            courses={courses}
            selectedCategoryId={selectedCategoryId}
            onSelect={onSelect}
            depth={0}
          />
        ))}
      </ul>
    </aside>
  )
}

function CategoryBranch({
  node,
  courses,
  selectedCategoryId,
  onSelect,
  depth,
}: {
  node: CategoryNode
  courses: CourseSummary[]
  selectedCategoryId: string | null
  onSelect: (id: string | null) => void
  depth: number
}) {
  const count = countCategory(courses, node.id)
  const active = selectedCategoryId === node.id
  return (
    <li>
      <button
        type="button"
        className={`shelf-nav-item${active ? ' is-active' : ''}`}
        style={{ paddingLeft: `${0.65 + depth * 0.75}rem` }}
        onClick={() => onSelect(node.id)}
        aria-current={active ? 'page' : undefined}
      >
        <span>{node.name}</span>
        <span className="shelf-nav-count">{count}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="shelf-nav-tree">
          {node.children.map((child) => (
            <CategoryBranch
              key={child.id}
              node={child}
              courses={courses}
              selectedCategoryId={selectedCategoryId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
