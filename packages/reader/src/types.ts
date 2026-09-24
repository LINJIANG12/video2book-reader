/**
 * 阅读器对外类型。契约来源：docs/03-阅读器设计.md §2.1
 *
 * 一条硬约束（docs/00 §4 不变量 3）：本包**不依赖** agent / 插件 / 端口实现 / 任何壳。
 * 静态版就是靠"换掉 2 个端口 + 换 StorePort 装配"得到的，阅读功能一行不改。
 */

import type { ReactNode } from 'react'

export type CourseId = string
export type DocumentId = string

export type CourseCatalogCategory = {
  id: string
  name: string
}

export type CourseCatalogEntry = {
  title: string
  direction: string
  publishPath: string
  categoryPaths: string[]
  tags: string[]
}

export type CourseCatalog = {
  schemaVersion: number
  categories: CourseCatalogCategory[]
  courses: Record<CourseId, CourseCatalogEntry>
}

/** volume = 模块全书（册）；note = 复习笔记；subtitle = 逐字稿（.txt 或块级 .md，无阅读视图） */
export type DocumentKind = 'volume' | 'note' | 'subtitle'

export type DocumentSummary = {
  id: DocumentId
  kind: DocumentKind
  title: string
  originIndex: number
  /** 字节数。缓存键、性能基准取最大者、「需要联网」判定都用它 */
  size: number
}

export type CourseSummary = {
  id: CourseId
  title: string
  /** 展示性文案，best-effort，可为空（docs/03 §2.3） */
  direction?: string
  /** 仓库内物理课程目录；有 catalog 时提供 */
  publishPath?: string
  /** 逻辑分类路径；交叉分类可重复出现在不同分类下 */
  categoryPaths?: string[]
  tags?: string[]
  volumeCount: number
  noteCount: number
  /** 逐字稿数量。列表只在 loadCourse 里给（书架不需要） */
  subtitleCount: number
}

export type CourseDetail = CourseSummary & {
  /** 册 + 笔记 + 逐字稿，按 kind 区分（调用方自己分组） */
  documents: DocumentSummary[]
}

// ---- 构建期生成的 manifest（静态站用；桌面版不用，见 docs/03 §2.3）----

export type ManifestCourse = {
  id: CourseId
  title: string
  direction: string
  /** 仓库内物理课程目录，catalog v2 提供 */
  publishPath: string
  /** 逻辑主分类与交叉分类路径 */
  categoryPaths: string[]
  tags: string[]
  volumes: DocumentSummary[]
  notes: DocumentSummary[]
  /** 逐字稿：`PXX_*.txt` 或 `BLKxx_*.md`。只列出与下载，不提供阅读视图 */
  subtitles: DocumentSummary[]
  /** 该课程全部产件的字节数（册 + 笔记 + 逐字稿） */
  bytes: number
}

export type Manifest = {
  manifestVersion: number
  generatedAt: string
  repo: { owner: string; name: string; ref: string }
  categories: CourseCatalogCategory[]
  stats: { courses: number; volumes: number; notes: number; subtitles: number; bytes: number }
  largestVolume?: { courseId: CourseId; id: DocumentId; size: number }
  courses: ManifestCourse[]
}

// ---- 内容源接缝 ----

/**
 * 结构搜索的一条命中。
 * **只搜标题，不搜正文**——跨库全文检索需要构建期倒排索引，是另一件事（docs/00 §11 D3，v2）。
 * 标题全在已加载的结构里，所以这个查询**零网络、零索引成本**。
 */
export type TitleHit = {
  courseId: CourseId
  /** 课程展示名，用于在结果里标注出处（搜到一册但不知道是哪门课是很糟的体验） */
  courseTitle: string
  /** 命中课程本身时没有 documentId */
  documentId?: DocumentId
  kind: DocumentKind | 'course'
  title: string
}

export type ContentSource = {
  listCourses(): Promise<CourseSummary[]>
  listCategories(): Promise<CourseCatalogCategory[]>
  loadCourse(id: CourseId): Promise<CourseDetail>
  loadDocument(id: DocumentId, signal?: AbortSignal): Promise<string>
  /** 在已加载的课程结构里搜标题。实现不得为此发起额外网络请求（见下） */
  searchTitles(query: string, signal?: AbortSignal): Promise<TitleHit[]>
}

// ---- 阅读状态事件（阅读器只发事件，不管存哪；docs/03 §9.3）----

/** 阅读器只发这两件事。「存哪、要不要存」全由调用方决定 */
export type ReadingEvents = {
  onChapterEnter?: (documentId: DocumentId, chapterIndex: number) => void
  onScrollAnchor?: (documentId: DocumentId, chapterIndex: number, blockId: string) => void
}

// ---- 导航原语（docs/03 §9.4）----

/**
 * 大纲节点。**四层**：册标题 → 章(H2) → 节(H3) → 小节(H4)。
 *
 * 为什么下探到 H4：左栏要的是 Typora 那种可折叠的层级树，
 * 只到 H3 会让长章的节挤成一条平的长列表（实测一册有 39 个 H3）。
 * H4 默认折叠，不主动撑开（docs/03 §9.2）。
 */
export type OutlineNode = {
  title: string
  level: 1 | 2 | 3 | 4
  blockId: string
  children: OutlineNode[]
}

export type BlockContext = {
  chapterIndex: number
  sectionPath: string[]
}

export type ReaderApi = {
  scrollToBlock(blockId: string): void
  getBlockContext(blockId: string): BlockContext | undefined
  getOutline(): OutlineNode[]
  getPosition(): { chapterIndex: number; blockId: string }
}

/** 阅读器对外接受的插槽（普通 React props；插槽注册表住在 app 层，docs/03 §0.1.1） */
export type ReaderSlots = {
  selectionActionsSlot?: ReactNode
  toolbarSlot?: ReactNode
  sidePanel?: ReactNode
}
