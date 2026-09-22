/**
 * 下载：当前册的原始 Markdown、整门课的 zip。
 *
 * 内容一律走 `ContentSource.loadDocument()` —— 也就是走与在线阅读**完全相同**的取数与缓存路径：
 * CDN 回退链、IndexedDB 缓存、期望大小校验都在那里，这里不重复实现。
 * 好处是"读过的那一册"下载是**零网络**的（已缓存），而且下载完的内容之后离线也能读。
 */
import type { ContentSource, CourseDetail } from '@app/reader'
import { buildZip, type ZipEntry } from './zip.ts'

export type Progress = { done: number; total: number }

/** 存一个文本文件。用 a[download] 触发，不需要任何库 */
export function saveTextFile(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void {
  saveBlob(filename, new Blob([text], { type: mime }))
}

export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器来不及取数据，延后一拍
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 路径最后一段当文件名 */
export function fileNameOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1)
}

export type DownloadHandle = {
  /** 拉取阶段的进度；打包阶段会停在 total/total */
  progress: Progress
  cancel: () => void
}

/**
 * 整门课打包下载。
 *
 * 并发固定 4：一门课最多两百多个文件（册 + 笔记 + 逐字稿），串行太慢、
 * 全并发会同时压几十个请求打同一个 CDN。4 是"够快又不像攻击"的折中。
 */
export function downloadCourseZip(
  course: CourseDetail,
  contentSource: ContentSource,
  onProgress: (p: Progress) => void,
): DownloadHandle {
  const ac = new AbortController()
  const docs = course.documents
  const progress: Progress = { done: 0, total: docs.length + 1 }
  const report = () => onProgress({ ...progress })

  report()

  const entries: ZipEntry[] = []
  const queue = docs.slice()
  const encoder = new TextEncoder()

  const worker = async (): Promise<void> => {
    for (;;) {
      const doc = queue.shift()
      if (!doc || ac.signal.aborted) return
      try {
        const text = await contentSource.loadDocument(doc.id, ac.signal)
        // 归档内保留仓库里的目录结构，解压出来就是一个规整的课程文件夹
        entries.push({ name: doc.id, data: encoder.encode(text) })
      } catch {
        // 单个文件失败不该让整包失败——跳过它，最后按实际条目数交付
      }
      progress.done += 1
      report()
    }
  }

  void (async () => {
    await Promise.all(Array.from({ length: 4 }, worker))
    if (ac.signal.aborted) return

    // 顺序按路径排一下，解压出来目录结构可读（并发 push 的顺序是乱的）
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    const zip = await buildZip(entries)
    if (ac.signal.aborted) return
    progress.done = progress.total
    report()
    saveBlob(`${course.title}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }))
  })()

  return { progress, cancel: () => ac.abort() }
}
