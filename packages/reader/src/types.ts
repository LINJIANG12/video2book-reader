/**
 * 阅读器对外类型。契约来源：docs/03-阅读器设计.md §2.1
 *
 * 一条硬约束（docs/00 §4 不变量 3）：本包**不依赖** agent / 插件 / 端口实现 / 任何壳。
 * 静态版就是靠"换掉 2 个端口 + 换 StorePort 装配"得到的，阅读功能一行不改。
 */

import type { ReactNode } from 'react'

export type CourseId = string
export type DocumentId = string

/** volume = 模块全书（册）；note = 复习笔记；subtitle = 逐字稿（.txt，无阅读视图） */
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
  volumeCount: number
  noteCount: number
  subtitleCount: number
}

export type CourseDetail = CourseSummary & {
  documents: DocumentSummary[]
}

// ---- 构建期生成的 manifest（静态站用；桌面版不用，见 docs/03 §2.3）----

export type ManifestCourse = {
  id: CourseId
  title: string
  direction: string
  volumes: DocumentSummary[]
  notes: DocumentSummary[]
  subtitleCount: number
  bytes: number
}

export type Manifest = {
  manifestVersion: number
  generatedAt: string
  repo: { owner: string; name: string; ref: string }
  stats: { courses: number; volumes: number; notes: number; subtitles: number; bytes: number }
  largestVolume?: { courseId: CourseId; id: DocumentId; size: number }
  courses: ManifestCourse[]
}

// ---- 内容源接缝 ----

export type ContentSource = {
  listCourses(): Promise<CourseSummary[]>
  loadCourse(id: CourseId): Promise<CourseDetail>
  loadDocument(id: DocumentId, signal?: AbortSignal): Promise<string>
  capabilities: { offline: boolean; writable: false }
}

// ---- 阅读状态事件（阅读器只发事件，不管存哪；docs/03 §9.3）----

export type ReadingEvents = {
  onChapterEnter?: (documentId: DocumentId, chapterIndex: number) => void
  onScrollAnchor?: (documentId: DocumentId, chapterIndex: number, blockId: string) => void
  onBookmarkToggle?: (documentId: DocumentId, chapterIndex: number) => void
}

// ---- 导航原语（docs/03 §9.4）----

export type OutlineNode = {
  title: string
  level: 1 | 2 | 3
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
