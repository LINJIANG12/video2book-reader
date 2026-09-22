/**
 * 从文件树派生课程结构的**纯函数**。
 *
 * 为什么要单独一个文件：构建期（scripts/gen-manifest.mjs，Node 直接 import TS）
 * 与运行期（GitHubSource，浏览器）都要用它。写两份一定会漂移。
 *
 * 派生纪律（docs/03 §2.3）：结构信息**全部从文件树派生**——确定性、不解析正文。
 * 展示性文案从课程仓根 README 抽取，**抽取失败只影响卡片上一行字，不影响任何功能**。
 */
import type { DocumentSummary, ManifestCourse } from '../types.ts'

export type TreeEntry = { path: string; type: string; size?: number }

/** 从文件名解析产件类型、序号与标题 */
export function parseDocName(path: string): { kind: 'volume' | 'note'; originIndex: number; title: string } | null {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const m = /^(模块|笔记)(\d+)_(.*)\.md$/.exec(base)
  if (!m) return null
  return {
    kind: m[1] === '模块' ? 'volume' : 'note',
    originIndex: Number(m[2]),
    // 去掉产件尾部的中文件名（_精读全书 / _笔记），保留中间可能含空格的标题
    title: m[3].replace(/_(精读全书|笔记)$/, ''),
  }
}

export type RootReadmeInfo = {
  /** 策展顺序（课程 id 列表） */
  order: string[]
  meta: Map<string, { title: string; direction: string }>
}

/**
 * 解析课程仓根 README 的收录表格，拿到策展顺序与展示文案。
 * best-effort：解析失败只影响排序与一行字。
 */
export function parseRootReadme(markdown: string): RootReadmeInfo {
  const order: string[] = []
  const meta = new Map<string, { title: string; direction: string }>()

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // 形如：['', '[**课程名**](目录/)', '方向 · 标签', '87', '25', '17', '87', '']
    if (cells.length < 4) continue

    const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(cells[1] ?? '')
    if (!link) continue
    const target = link[2]
    if (!target.endsWith('/')) continue // 课程目录一定以 / 结尾
    const id = decodeURIComponent(target.replace(/\/$/, ''))
    if (id.startsWith('http') || id.includes('/')) continue

    order.push(id)
    meta.set(id, { title: link[1].replace(/\*\*/g, '').trim(), direction: cells[2] ?? '' })
  }

  return { order, meta }
}

/**
 * 从文件树条目派生课程列表。
 * 只认 `.../textbooks/xxx.md`（册）与 `.../notes/xxx.md`（笔记）；逐字稿只计数。
 */
export function deriveCourses(files: TreeEntry[], readme?: RootReadmeInfo): ManifestCourse[] {
  const courses = new Map<string, ManifestCourse>()

  for (const file of files) {
    const parts = file.path.split('/')
    if (parts.length < 3) continue // 根目录文件（README / RULES）跳过
    const courseId = parts[0]
    const dir = parts[1]

    let course = courses.get(courseId)
    if (!course) {
      course = { id: courseId, title: courseId, direction: '', volumes: [], notes: [], subtitleCount: 0, bytes: 0 }
      courses.set(courseId, course)
    }

    if (dir === 'subtitles') {
      if (file.path.endsWith('.txt')) course.subtitleCount += 1
      continue
    }

    const isVolume = dir === 'textbooks' && file.path.endsWith('.md')
    const isNote = dir === 'notes' && file.path.endsWith('.md')
    if (!isVolume && !isNote) continue

    const parsed = parseDocName(file.path)
    if (!parsed) continue

    const doc: DocumentSummary = {
      id: file.path,
      kind: parsed.kind,
      title: parsed.title,
      originIndex: parsed.originIndex,
      size: file.size ?? 0,
    }
    if (isVolume) course.volumes.push(doc)
    else course.notes.push(doc)
    course.bytes += doc.size
  }

  const list = [...courses.values()]
  for (const c of list) {
    const m = readme?.meta.get(c.id)
    if (m) {
      c.title = m.title || c.id
      c.direction = m.direction
    }
    c.volumes.sort((a, b) => a.originIndex - b.originIndex)
    c.notes.sort((a, b) => a.originIndex - b.originIndex)
  }

  // 策展顺序优先；README 里没有的（新增课程还没更新 README）追加到后面，按目录名排
  const rank = new Map((readme?.order ?? []).map((id, i) => [id, i]))
  list.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER
    return ra !== rb ? ra - rb : a.id.localeCompare(b.id, 'zh')
  })

  return list
}

export function toCourseSummary(c: ManifestCourse) {
  return {
    id: c.id,
    title: c.title,
    direction: c.direction,
    volumeCount: c.volumes.length,
    noteCount: c.notes.length,
    subtitleCount: c.subtitleCount,
  }
}
