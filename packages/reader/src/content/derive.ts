/**
 * 从文件树派生课程结构的纯函数。
 *
 * 构建期 manifest 和运行期 GitHub tree 共用这份逻辑。课程仓现在使用
 * `publish_path` 指定物理目录，catalog 缺失时仍兼容旧的平铺布局。
 */
import type {
  CourseCatalog,
  CourseCatalogCategory,
  CourseCatalogEntry,
  CourseId,
  DocumentKind,
  DocumentSummary,
  ManifestCourse,
} from '../types.ts'

export type TreeEntry = { path: string; type: string; size?: number }

const ARTIFACT_DIRS = new Set(['textbooks', 'notes', 'subtitles'])

/** 从文件名解析产件类型、序号与标题。 */
export function parseDocName(path: string): { kind: DocumentKind; originIndex: number; title: string } | null {
  const base = path.slice(path.lastIndexOf('/') + 1)

  const md = /^(模块|笔记)(\d+)_(.*)\.md$/.exec(base)
  if (md) {
    return {
      kind: md[1] === '模块' ? 'volume' : 'note',
      originIndex: Number(md[2]),
      title: md[3].replace(/_(精读全书|笔记)$/, ''),
    }
  }

  if (base.endsWith('.txt')) {
    const sub = /^P(\d+)_(.*?)(?:_clean)?\.txt$/.exec(base)
    return {
      kind: 'subtitle',
      originIndex: sub ? Number(sub[1]) : 0,
      title: sub ? sub[2] : base.replace(/\.txt$/, ''),
    }
  }

  if (base.endsWith('_逐字稿.md')) {
    const sub = /^BLK(\d+)_(.*?)(?:_逐字稿)?\.md$/.exec(base)
    return {
      kind: 'subtitle',
      originIndex: sub ? Number(sub[1]) : 0,
      title: sub ? sub[2] : base.replace(/_逐字稿\.md$/, ''),
    }
  }

  return null
}

export type RootReadmeInfo = {
  order: CourseId[]
  meta: Map<CourseId, { title: string; direction: string }>
}

function normalizePublishPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/** 解析课程仓的 schema v2 catalog，并转换为 reader 内部类型。 */
export function parseCourseCatalog(value: unknown): CourseCatalog {
  if (!value || typeof value !== 'object') throw new Error('course_catalog.json 必须是对象')
  const raw = value as Record<string, unknown>
  if (raw.schema_version !== 2) throw new Error(`不支持的 catalog schema_version: ${String(raw.schema_version)}`)

  const rawCategories = raw.categories
  if (!Array.isArray(rawCategories) || rawCategories.length === 0) throw new Error('catalog categories 必须是非空数组')
  const categories: CourseCatalogCategory[] = rawCategories.map((item) => {
    const category = item as Record<string, unknown>
    if (typeof category.id !== 'string' || typeof category.name !== 'string') throw new Error('catalog 分类缺少 id/name')
    return { id: category.id, name: category.name }
  })

  const rawCourses = raw.courses
  if (!rawCourses || typeof rawCourses !== 'object' || Array.isArray(rawCourses)) throw new Error('catalog courses 必须是对象')
  const courses: Record<CourseId, CourseCatalogEntry> = {}
  for (const [courseId, item] of Object.entries(rawCourses as Record<string, unknown>)) {
    const course = item as Record<string, unknown>
    if (typeof course.title !== 'string' || typeof course.direction !== 'string' || typeof course.publish_path !== 'string') {
      throw new Error(`catalog 课程 ${courseId} 缺少 title/direction/publish_path`)
    }
    if (!Array.isArray(course.category_paths) || course.category_paths.some((path) => typeof path !== 'string')) {
      throw new Error(`catalog 课程 ${courseId} 的 category_paths 非法`)
    }
    if (course.tags !== undefined && (!Array.isArray(course.tags) || course.tags.some((tag) => typeof tag !== 'string'))) {
      throw new Error(`catalog 课程 ${courseId} 的 tags 非法`)
    }
    courses[courseId] = {
      title: course.title,
      direction: course.direction,
      publishPath: normalizePublishPath(course.publish_path),
      categoryPaths: course.category_paths,
      tags: course.tags ?? [],
    }
  }
  return { schemaVersion: 2, categories, courses }
}

/** 解析根 README 的课程表格，兼容 catalog 物理路径和旧平铺路径。 */
export function parseRootReadme(markdown: string, catalog?: CourseCatalog): RootReadmeInfo {
  const order: CourseId[] = []
  const meta = new Map<CourseId, { title: string; direction: string }>()
  const publishToId = new Map(
    Object.entries(catalog?.courses ?? {}).map(([id, entry]) => [entry.publishPath, id]),
  )

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 4) continue

    const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(cells[1] ?? '')
    if (!link) continue
    const target = link[2]
    if (!target.endsWith('/') || target.startsWith('http')) continue
    let decoded: string
    try {
      decoded = decodeURIComponent(target.replace(/\/$/, ''))
    } catch {
      continue
    }
    const normalized = normalizePublishPath(decoded)
    const id = publishToId.get(normalized) ?? normalized.split('/').filter(Boolean).at(-1)
    if (!id) continue

    order.push(id)
    meta.set(id, { title: link[1].replace(/\*\*/g, '').trim(), direction: cells[2] ?? '' })
  }

  return { order, meta }
}

type LocatedArtifact = { courseId: CourseId; publishPath: string; kindDir: string }

/** 根据 catalog 优先、无 catalog 回退，从任意深度的文件路径定位课程。 */
function locateArtifact(path: string, catalog?: CourseCatalog): LocatedArtifact | null {
  const byPublishPath = new Map(
    Object.entries(catalog?.courses ?? {}).map(([id, entry]) => [entry.publishPath, { id, entry }]),
  )
  for (const [publishPath, match] of byPublishPath) {
    if (path === publishPath || !path.startsWith(`${publishPath}/`)) continue
    const relative = path.slice(publishPath.length + 1)
    const kindDir = relative.split('/')[0]
    if (!ARTIFACT_DIRS.has(kindDir)) continue
    return { courseId: match.id, publishPath, kindDir }
  }

  const parts = path.split('/')
  const dirIndex = parts.findIndex((part) => ARTIFACT_DIRS.has(part))
  if (dirIndex < 1) return null
  const kindDir = parts[dirIndex]
  const publishPath = parts.slice(0, dirIndex).join('/')
  return { courseId: parts[dirIndex - 1], publishPath, kindDir }
}

/** 从完整文档路径反查稳定课程 ID，找不到时返回 undefined。 */
export function courseIdFromDocumentId(documentId: string): CourseId | undefined {
  const parts = documentId.split('/')
  const dirIndex = parts.findIndex((part) => ARTIFACT_DIRS.has(part))
  return dirIndex > 0 ? parts[dirIndex - 1] : undefined
}

function emptyCourse(id: CourseId, publishPath: string, entry?: CourseCatalogEntry): ManifestCourse {
  return {
    id,
    title: entry?.title ?? id,
    direction: entry?.direction ?? '',
    publishPath,
    categoryPaths: entry?.categoryPaths ?? [],
    tags: entry?.tags ?? [],
    volumes: [],
    notes: [],
    subtitles: [],
    bytes: 0,
  }
}

/** 从文件树派生课程列表；只认 textbooks/notes/subtitles 下的合法产件。 */
export function deriveCourses(files: TreeEntry[], readme?: RootReadmeInfo, catalog?: CourseCatalog): ManifestCourse[] {
  const courses = new Map<CourseId, ManifestCourse>()

  for (const file of files) {
    const located = locateArtifact(file.path, catalog)
    if (!located) continue

    const isVolume = located.kindDir === 'textbooks' && file.path.endsWith('.md')
    const isNote = located.kindDir === 'notes' && file.path.endsWith('.md')
    const isSubtitle = located.kindDir === 'subtitles' && (file.path.endsWith('.txt') || file.path.endsWith('.md'))
    if (!isVolume && !isNote && !isSubtitle) continue

    const parsed = parseDocName(file.path)
    if (!parsed) continue

    let course = courses.get(located.courseId)
    if (!course) {
      const entry = catalog?.courses[located.courseId]
      course = emptyCourse(located.courseId, located.publishPath, entry)
      courses.set(located.courseId, course)
    }

    const doc: DocumentSummary = {
      id: file.path,
      kind: parsed.kind,
      title: parsed.title,
      originIndex: parsed.originIndex,
      size: file.size ?? 0,
    }
    if (isVolume) course.volumes.push(doc)
    else if (isNote) course.notes.push(doc)
    else course.subtitles.push(doc)
    course.bytes += doc.size
  }

  const list = [...courses.values()]
  const byIndex = (a: DocumentSummary, b: DocumentSummary) => a.originIndex - b.originIndex || a.title.localeCompare(b.title, 'zh')
  for (const course of list) {
    const entry = catalog?.courses[course.id]
    const readmeMeta = readme?.meta.get(course.id)
    if (entry) {
      course.title = entry.title || course.id
      course.direction = entry.direction
    } else if (readmeMeta) {
      course.title = readmeMeta.title || course.id
      course.direction = readmeMeta.direction
    }
    course.volumes.sort(byIndex)
    course.notes.sort(byIndex)
    course.subtitles.sort(byIndex)
  }

  const rank = new Map((readme?.order ?? []).map((id, index) => [id, index]))
  list.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER
    return ra !== rb ? ra - rb : a.id.localeCompare(b.id, 'zh')
  })

  return list
}

export function toCourseSummary(course: ManifestCourse) {
  return {
    id: course.id,
    title: course.title,
    direction: course.direction,
    publishPath: course.publishPath,
    categoryPaths: course.categoryPaths,
    tags: course.tags,
    volumeCount: course.volumes.length,
    noteCount: course.notes.length,
    subtitleCount: course.subtitles.length,
  }
}
