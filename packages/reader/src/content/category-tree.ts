import type { CourseCatalogCategory, CourseSummary } from '../types.ts'

export type CategoryNode = CourseCatalogCategory & { children: CategoryNode[] }
export type CourseGroup = { id: string; name: string; courses: CourseSummary[] }

const UNCATEGORIZED = '__uncategorized__'

/** 按 catalog 顺序构造分类树；未知父分类的节点降级为根节点。 */
export function buildCategoryTree(categories: CourseCatalogCategory[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>()
  for (const category of categories) nodes.set(category.id, { ...category, children: [] })

  const roots: CategoryNode[] = []
  for (const category of categories) {
    const node = nodes.get(category.id)!
    const parentId = category.id.includes('.') ? category.id.slice(0, category.id.lastIndexOf('.')) : ''
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** 返回所有有子节点的分类 ID。 */
export function collectBranchIds(tree: CategoryNode[]): string[] {
  const ids: string[] = []
  const walk = (nodes: CategoryNode[]) => {
    for (const node of nodes) {
      if (node.children.length === 0) continue
      ids.push(node.id)
      walk(node.children)
    }
  }
  walk(tree)
  return ids
}

/** 按实际构建树返回从根到父节点的祖先链。 */
export function findCategoryAncestors(tree: CategoryNode[], categoryId: string): string[] {
  const walk = (nodes: CategoryNode[], ancestors: string[]): string[] | undefined => {
    for (const node of nodes) {
      if (node.id === categoryId) return ancestors
      const found = walk(node.children, [...ancestors, node.id])
      if (found) return found
    }
    return undefined
  }
  return walk(tree, []) ?? []
}

/** 判断节点是否位于当前选中分类的祖先路径上。 */
export function isCategoryInPath(tree: CategoryNode[], categoryId: string, selectedCategoryId: string | null): boolean {
  if (!selectedCategoryId) return false
  return categoryId === selectedCategoryId || findCategoryAncestors(tree, selectedCategoryId).includes(categoryId)
}

function pathsFor(course: CourseSummary): string[] {
  return course.categoryPaths ?? []
}

/** 判断课程是否属于分类本身或其任意后代。 */
export function categoryContainsCourse(course: CourseSummary, categoryId: string | null): boolean {
  if (!categoryId) return true
  return pathsFor(course).some((path) => path === categoryId || path.startsWith(`${categoryId}.`))
}

/** 统计分类及后代的课程数，按课程 ID 去重。 */
export function countCategory(courses: CourseSummary[], categoryId: string): number {
  return new Set(courses.filter((course) => categoryContainsCourse(course, categoryId)).map((course) => course.id)).size
}

/** 将可见课程按当前分类视图分组；同一课程在一个视图中只出现一次。 */
export function groupCourses(
  courses: CourseSummary[],
  selectedCategoryId: string | null,
  categories: CourseCatalogCategory[],
): CourseGroup[] {
  const categoryOrder = new Map(categories.map((category, index) => [category.id, index]))
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
  const groups = new Map<string, CourseSummary[]>()

  for (const course of courses) {
    if (!categoryContainsCourse(course, selectedCategoryId)) continue
    const matchingPaths = selectedCategoryId
      ? pathsFor(course)
          .filter((path) => path === selectedCategoryId || path.startsWith(`${selectedCategoryId}.`))
          .sort((a, b) => b.length - a.length)
      : pathsFor(course)
    const groupId = matchingPaths[0] ?? (selectedCategoryId ?? UNCATEGORIZED)
    const group = groups.get(groupId) ?? []
    group.push(course)
    groups.set(groupId, group)
  }

  return [...groups.entries()]
    .map(([id, groupCourses]) => ({
      id,
      name: categoryNames.get(id) ?? (id === UNCATEGORIZED ? '未分类' : id),
      courses: groupCourses,
    }))
    .sort((a, b) => {
      const ai = categoryOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const bi = categoryOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER
      return ai - bi || a.name.localeCompare(b.name, 'zh')
    })
}

export { UNCATEGORIZED }
