/**
 * 阅读器公开出口。
 *
 * 本包**不依赖** agent / 插件 / 端口实现 / 任何壳（docs/00 §4 不变量 3）。
 * 静态版就是靠"换掉 2 个端口 + 换 StorePort 装配"得到的，阅读功能一行不改。
 */

export type {
  BlockContext,
  ContentSource,
  CourseDetail,
  CourseId,
  CourseSummary,
  DocumentId,
  DocumentKind,
  DocumentSummary,
  Manifest,
  ManifestCourse,
  OutlineNode,
  ReaderApi,
  ReaderSlots,
  ReadingEvents,
  TitleHit,
} from './types.ts'

export { createGitHubSource, type DocumentCache, type GitHubSourceOptions } from './content/github-source.ts'
export { deriveCourses, parseDocName, parseRootReadme, toCourseSummary } from './content/derive.ts'

export { splitDocument, parseChapterMeta, type ChapterMeta, type DocPart, type DocPartRole, type SplitDocument } from './model/split-document.ts'

export { guardRunawayMath, type MathGuardHit, type MathGuardOptions } from "./markdown/math-guard.ts"
export { rehypeCallouts, type CalloutKind } from './markdown/callouts.ts'
export { rehypeBlockAnchors, type BlockAnchorResult } from './markdown/anchors.ts'
export { transformPart, transformDocument, createAnchorResult, hastToText } from './markdown/transform.ts'
export { renderPart } from './markdown/render.ts'

export { Reader, type ReaderProps } from './ui/Reader.tsx'
export { Bookshelf, type BookshelfProps } from './ui/Bookshelf.tsx'
