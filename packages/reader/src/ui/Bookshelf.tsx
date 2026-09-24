/**
 * 书架：多级分类导航、按主分类分组和课程索引。
 *
 * 分类数据来自 catalog/manifest；每门课程在当前视图只出现一次，交叉分类
 * 只用于筛选和导航，不重复累计课程、册数或笔记数。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildCategoryTree,
  categoryContainsCourse,
  collectBranchIds,
  countCategory,
  findCategoryAncestors,
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

const ALL_COURSES_ID = '__all_courses__'

function treeDomId(categoryId: string): string {
  return `shelf-tree-${categoryId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function Bookshelf({ contentSource, onOpen, progress = {} }: BookshelfProps) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const initializedTree = useRef(false)
  const navRef = useRef<HTMLElement>(null)
  const mobileToggleRef = useRef<HTMLButtonElement>(null)

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
  const branchIds = useMemo(() => collectBranchIds(tree), [tree])
  const groups = useMemo(
    () => groupCourses(courses, selectedCategoryId, categories),
    [courses, selectedCategoryId, categories],
  )
  const visibleCourses = useMemo(
    () => courses.filter((course) => categoryContainsCourse(course, selectedCategoryId)),
    [courses, selectedCategoryId],
  )
  const courseOrder = useMemo(() => new Map(courses.map((course, index) => [course.id, index])), [courses])
  const selectedAncestors = useMemo(
    () => (selectedCategoryId ? findCategoryAncestors(tree, selectedCategoryId) : []),
    [tree, selectedCategoryId],
  )
  const activePathIds = useMemo(
    () => new Set(selectedCategoryId ? [...selectedAncestors, selectedCategoryId] : []),
    [selectedAncestors, selectedCategoryId],
  )

  useEffect(() => {
    if (state.phase !== 'ready') return
    const valid = new Set(branchIds)
    setCollapsedIds((previous) => {
      if (!initializedTree.current) {
        initializedTree.current = true
        return new Set(branchIds.filter((id) => id.includes('.')))
      }
      return new Set([...previous].filter((id) => valid.has(id)))
    })
  }, [branchIds, state.phase])

  const selectCategory = useCallback((categoryId: string | null) => {
    setSelectedCategoryId(categoryId)
    if (categoryId) {
      const ancestors = findCategoryAncestors(tree, categoryId)
      setCollapsedIds((previous) => {
        const next = new Set(previous)
        ancestors.forEach((ancestor) => next.delete(ancestor))
        return next
      })
    }
    setMobileNavOpen(false)
  }, [tree])

  const toggleCategory = useCallback((categoryId: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }, [])

  const expandAll = useCallback(() => setCollapsedIds(new Set()), [])
  const collapseAll = useCallback(() => setCollapsedIds(new Set(branchIds)), [branchIds])

  const handleTreeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, categoryId: string, hasChildren: boolean) => {
      const visibleButtons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('[data-category-id]') ?? []).filter(
        (button) => button.offsetParent !== null,
      )
      const index = visibleButtons.findIndex((button) => button.dataset.categoryId === categoryId)
      const focusAt = (nextIndex: number) => {
        const button = visibleButtons[(nextIndex + visibleButtons.length) % visibleButtons.length]
        button?.focus()
      }
      const focusCategory = (targetId: string) => visibleButtons.find((button) => button.dataset.categoryId === targetId)?.focus()

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        focusAt(index + 1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        focusAt(index - 1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        focusAt(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        focusAt(visibleButtons.length - 1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        const node = findNode(tree, categoryId)
        if (hasChildren && collapsedIds.has(categoryId)) toggleCategory(categoryId)
        else if (node?.children[0]) focusCategory(node.children[0].id)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (hasChildren && !collapsedIds.has(categoryId)) toggleCategory(categoryId)
        else {
          const parent = findCategoryAncestors(tree, categoryId).at(-1)
          if (parent) focusCategory(parent)
        }
      }
    },
    [collapsedIds, selectedAncestors, toggleCategory, tree],
  )

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
  const selectedPath = selectedCategoryId
    ? [...selectedAncestors, selectedCategoryId].map((id) => categories.find((category) => category.id === id)?.name ?? id)
    : []

  return (
    <div className="shelf">
      <div className={`shelf-layout${categories.length === 0 ? ' shelf-no-nav' : ''}${navCollapsed ? ' shelf-nav-collapsed' : ''}`}>
        {categories.length > 0 && (
          <>
            <button
              ref={mobileToggleRef}
              type="button"
              className="shelf-mobile-nav-toggle"
              aria-expanded={mobileNavOpen}
              aria-controls="shelf-category-nav"
              onClick={() => {
                if (navCollapsed) setNavCollapsed(false)
                setMobileNavOpen((open) => !open)
              }}
            >
              <span>分类 · {selectedName}</span>
              <span>{visibleCourses.length} 门</span>
              <span aria-hidden="true">{mobileNavOpen ? '▴' : '▾'}</span>
            </button>
            <CategoryNav
              ref={navRef}
              id="shelf-category-nav"
              courses={courses}
              tree={tree}
              hasBranches={branchIds.length > 0}
              collapsedIds={collapsedIds}
              activePathIds={activePathIds}
              selectedCategoryId={selectedCategoryId}
              onSelect={selectCategory}
              onNodeKeyDown={handleTreeKeyDown}
              onToggle={toggleCategory}
              onExpandAll={expandAll}
              onCollapseAll={collapseAll}
              navCollapsed={navCollapsed}
              onCollapseNav={() => setNavCollapsed((collapsed) => !collapsed)}
              mobileOpen={mobileNavOpen}
              onKeyDownEscape={() => {
                setMobileNavOpen(false)
                mobileToggleRef.current?.focus()
              }}
            />
          </>
        )}

        <main className="shelf-main">
          <header className="shelf-head">
            <h1>{selectedName}</h1>
            {selectedPath.length > 0 && (
              <nav className="shelf-breadcrumb" aria-label="当前分类路径">
                {selectedPath.map((name, index) => (
                  <span key={`${name}-${index}`}>
                    {index > 0 && <span aria-hidden="true"> / </span>}
                    {name}
                  </span>
                ))}
              </nav>
            )}
            <p className="shelf-stats" aria-live="polite" aria-atomic="true">
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
              <div className="shelf-filter-empty">
                <p>这个分类下暂时没有课程。</p>
                <button type="button" onClick={() => selectCategory(null)}>返回全部课程</button>
              </div>
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

function findNode(tree: CategoryNode[], categoryId: string): CategoryNode | undefined {
  for (const node of tree) {
    if (node.id === categoryId) return node
    const found = findNode(node.children, categoryId)
    if (found) return found
  }
  return undefined
}

function CategoryNav({
  ref,
  id,
  courses,
  tree,
  hasBranches,
  collapsedIds,
  activePathIds,
  selectedCategoryId,
  onSelect,
  onNodeKeyDown,
  onToggle,
  onExpandAll,
  onCollapseAll,
  navCollapsed,
  onCollapseNav,
  mobileOpen,
  onKeyDownEscape,
}: {
  ref: React.RefObject<HTMLElement | null>
  id: string
  courses: CourseSummary[]
  tree: CategoryNode[]
  hasBranches: boolean
  collapsedIds: Set<string>
  activePathIds: Set<string>
  selectedCategoryId: string | null
  onSelect: (id: string | null) => void
  onNodeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, id: string, hasChildren: boolean) => void
  onToggle: (id: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  navCollapsed: boolean
  onCollapseNav: () => void
  mobileOpen: boolean
  onKeyDownEscape: () => void
}) {
  if (navCollapsed) {
    return (
      <aside id={id} className="shelf-nav is-collapsed">
        <button type="button" className="shelf-nav-restore" onClick={onCollapseNav} aria-label="展开分类导航">
          <span aria-hidden="true">☰</span>
          <span>分类</span>
        </button>
      </aside>
    )
  }

  return (
    <aside
      ref={ref}
      id={id}
      className={`shelf-nav${mobileOpen ? ' is-mobile-open' : ''}`}
      aria-label="课程分类导航"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onKeyDownEscape()
      }}
    >
      <div className="shelf-nav-head">
        <div className="shelf-nav-title">分类导航</div>
        {hasBranches && (
          <div className="shelf-nav-actions">
            <button type="button" onClick={onExpandAll} aria-label="展开全部分类">全部展开</button>
            <button type="button" onClick={onCollapseAll} aria-label="收起全部分类">全部收起</button>
            <button type="button" onClick={onCollapseNav} aria-label="收起分类导航">收起</button>
          </div>
        )}
      </div>
      <button
        type="button"
        className={`shelf-nav-item shelf-nav-all${selectedCategoryId === null ? ' is-active' : ''}`}
        data-category-id={ALL_COURSES_ID}
        onClick={() => onSelect(null)}
        onKeyDown={(event) => onNodeKeyDown(event, ALL_COURSES_ID, false)}
        aria-current={selectedCategoryId === null ? 'page' : undefined}
      >
        <span>全部课程</span>
        <span className="shelf-nav-count">{courses.length}</span>
      </button>
      <ul className="shelf-nav-tree" role="tree" aria-label="课程分类">
        {tree.map((node) => (
          <CategoryBranch
            key={node.id}
            node={node}
            courses={courses}
            collapsedIds={collapsedIds}
            activePathIds={activePathIds}
            selectedCategoryId={selectedCategoryId}
            onSelect={onSelect}
            onToggle={onToggle}
            onKeyDown={onNodeKeyDown}
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
  collapsedIds,
  activePathIds,
  selectedCategoryId,
  onSelect,
  onToggle,
  onKeyDown,
  depth,
}: {
  node: CategoryNode
  courses: CourseSummary[]
  collapsedIds: Set<string>
  activePathIds: Set<string>
  selectedCategoryId: string | null
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, id: string, hasChildren: boolean) => void
  depth: number
}) {
  const hasChildren = node.children.length > 0
  const expanded = !collapsedIds.has(node.id)
  const selected = selectedCategoryId === node.id
  const inPath = activePathIds.has(node.id)
  return (
    <li role="none">
      <div className={`shelf-tree-row${inPath ? ' is-path' : ''}`} role="treeitem" aria-selected={selected} aria-expanded={hasChildren ? expanded : undefined}>
        {hasChildren ? (
          <button
            type="button"
            className="shelf-tree-toggle"
            aria-label={`${expanded ? '收起' : '展开'}${node.name}`}
            aria-expanded={expanded}
            aria-controls={treeDomId(node.id)}
            tabIndex={-1}
            onClick={() => onToggle(node.id)}
          >
            <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span className="shelf-tree-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className={`shelf-nav-item${selected ? ' is-active' : ''}${inPath ? ' is-path' : ''}`}
          data-category-id={node.id}
          style={{ paddingLeft: `${0.45 + depth * 0.55}rem` }}
          onClick={() => onSelect(node.id)}
          onKeyDown={(event) => onKeyDown(event, node.id, hasChildren)}
          aria-current={selected ? 'page' : undefined}
        >
          <span>{node.name}</span>
          <span className="shelf-nav-count">{countCategory(courses, node.id)}</span>
        </button>
      </div>
      {hasChildren && expanded && (
        <ul id={treeDomId(node.id)} className="shelf-nav-tree" role="group">
          {node.children.map((child) => (
            <CategoryBranch
              key={child.id}
              node={child}
              courses={courses}
              collapsedIds={collapsedIds}
              activePathIds={activePathIds}
              selectedCategoryId={selectedCategoryId}
              onSelect={onSelect}
              onToggle={onToggle}
              onKeyDown={onKeyDown}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
