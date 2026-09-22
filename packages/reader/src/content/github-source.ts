/**
 * `GitHubSource` —— 内容源接缝的默认实现（docs/03 §2）。
 *
 * 两种取数模式，**同一份代码**，只取决于部署时有没有带 manifest：
 *
 *   manifest 模式（静态站）：构建期生成 manifest.json 随站点发布 → 运行时**不碰 GitHub API**
 *   runtime 模式（桌面 / GitHub Pages）：运行时取文件树 → 每次都是最新结构
 *
 * 为什么静态站必须是前者：`api.github.com` 与 `raw.githubusercontent.com` 在国内网络下
 * 经常不可达或极慢（本机实测 raw 直接超时）。若站点运行时依赖它们，**书架直接出不来**——
 * 这与托管在哪个平台无关。而桌面版不能要求"新增课程必须重新发版"，所以必须运行时取树。
 *
 * 正文取数走回退链：jsDelivr → api contents → raw（每条都实测过可达性，见 docs/05）。
 */
import { deriveCourses, parseRootReadme, toCourseSummary, type RootReadmeInfo, type TreeEntry } from './derive.ts'
import type {
  ContentSource,
  CourseDetail,
  CourseId,
  CourseSummary,
  DocumentId,
  Manifest,
  ManifestCourse,
  TitleHit,
} from '../types.ts'

export type DocumentCache = {
  /** expectedSize 来自文件树 / manifest；实现可用它判断记录是否已失效 */
  get(key: string, expectedSize?: number): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

export type GitHubSourceOptions = {
  owner: string
  repo: string
  ref?: string
  /** 有则用它。**两种模式下都会用到**——它是失败时的兜底，不只是"另一种模式" */
  manifestUrl?: string
  /**
   * 结构优先从哪来：
   *   'runtime'  —— 先实时取树（永远最新），失败回退到 manifest。GitHub Pages 用这条。
   *   'manifest' —— 先读构建期 manifest（**运行时不碰 api.github.com**），失败回退到实时取树。Cloudflare 用这条。
   *
   * 之所以两向都要回退：实测遇到过 api.github.com 瞬时 403（限流窗口边界 / 代理抖动），
   * **一次失败就让整个书架不可用**——对分发的渠道来说这个失败模式太脆。
   */
  prefer?: 'manifest' | 'runtime'
  /** 可选持久化缓存，让已读的册离线可读。阅读器本身不认识存储实现 */
  cache?: DocumentCache
  /** 可选 token，仅用于提高 API 限流额度（60/小时 → 5000/小时） */
  token?: string
}

const API = 'https://api.github.com'
const CDN = 'https://cdn.jsdelivr.net/gh'
const RAW = 'https://raw.githubusercontent.com'

export function createGitHubSource(opts: GitHubSourceOptions): ContentSource {
  const { owner, repo, ref = 'main', manifestUrl, prefer = 'manifest', cache, token } = opts

  /** 结构只取一次，之后复用 */
  let coursesPromise: Promise<ManifestCourse[]> | null = null

  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return token ? { ...extra, authorization: `Bearer ${token}` } : extra
  }

  async function loadFromManifest(): Promise<ManifestCourse[]> {
    const res = await fetch(manifestUrl!)
    if (!res.ok) throw new Error(`取 manifest 失败：HTTP ${res.status}`)
    const manifest = (await res.json()) as Manifest
    return manifest.courses
  }

  async function loadFromTree(): Promise<ManifestCourse[]> {
    const [treeRes, readmeInfo] = await Promise.all([
      fetch(`${API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, { headers: authHeaders({ accept: 'application/vnd.github+json' }) }),
      fetchRootReadme(),
    ])
    if (!treeRes.ok) {
      // 403/429 基本都是未认证限流（60 次/小时/IP）。把原因说清楚，用户才知道该等一会儿还是换网络。
      const hint = treeRes.status === 403 || treeRes.status === 429 ? '（很可能是未认证限流：60 次/小时/IP）' : ''
      throw new Error(`HTTP ${treeRes.status} ${treeRes.statusText}${hint}`)
    }
    const json = (await treeRes.json()) as { tree: TreeEntry[]; truncated?: boolean }
    if (json.truncated) throw new Error('文件树被截断，需要改为逐目录取树')
    return deriveCourses(json.tree.filter((e) => e.type === 'blob'), readmeInfo)
  }

  async function fetchRootReadme(): Promise<RootReadmeInfo | undefined> {
    try {
      const res = await fetch(`${API}/repos/${owner}/${repo}/contents/README.md?ref=${ref}`, {
        headers: authHeaders({ accept: 'application/vnd.github.raw' }),
      })
      if (!res.ok) return undefined
      return parseRootReadme(await res.text())
    } catch {
      return undefined // best-effort：失败只退化为目录名排序
    }
  }

  function getCourses(): Promise<ManifestCourse[]> {
    coursesPromise ??= (async () => {
      // 两条路互为兜底，顺序由 prefer 决定。这样两种部署共用一份代码，
      // 且**任何一条路失败都不会让书架整个出不来**（见 GitHubSourceOptions.prefer 的说明）。
      const attempts: { needsManifest: boolean; name: string; run: () => Promise<ManifestCourse[]> }[] = [
        { needsManifest: true, name: '构建期 manifest', run: loadFromManifest },
        { needsManifest: false, name: '运行时取文件树', run: loadFromTree },
      ]
      if (prefer === 'runtime') attempts.reverse()

      const errors: string[] = []
      for (const attempt of attempts) {
        if (attempt.needsManifest && !manifestUrl) continue
        try {
          return await attempt.run()
        } catch (e) {
          errors.push(`${attempt.name}：${(e as Error).message}`)
        }
      }
      throw new Error(`课程结构读取失败 —— ${errors.join('；')}`)
    })()
    return coursesPromise
  }

  async function fetchContent(path: string, signal?: AbortSignal): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const attempts: { name: string; url: string; headers?: Record<string, string> }[] = [
      { name: 'jsDelivr', url: `${CDN}/${owner}/${repo}@${ref}/${encoded}` },
      { name: 'api', url: `${API}/repos/${owner}/${repo}/contents/${encoded}?ref=${ref}`, headers: authHeaders({ accept: 'application/vnd.github.raw' }) },
      { name: 'raw', url: `${RAW}/${owner}/${repo}/${ref}/${encoded}` },
    ]

    const errors: string[] = []
    for (const a of attempts) {
      try {
        const res = await fetch(a.url, { signal, headers: a.headers })
        if (!res.ok) {
          errors.push(`${a.name}: HTTP ${res.status}`)
          continue
        }
        return await res.text()
      } catch (e) {
        errors.push(`${a.name}: ${(e as Error).name}`)
      }
    }
    throw new Error(`拉取正文失败（${path}）——${errors.join('；')}`)
  }

  return {
    async listCourses(): Promise<CourseSummary[]> {
      return (await getCourses()).map(toCourseSummary)
    },

    async loadCourse(id: CourseId): Promise<CourseDetail> {
      const course = (await getCourses()).find((c) => c.id === id)
      if (!course) throw new Error(`没有这门课：${id}`)
      return {
        ...toCourseSummary(course),
        documents: [...course.volumes, ...course.notes, ...course.subtitles],
      }
    },

    /**
     * 结构搜索：在已加载的课程结构里按标题过滤，**不发任何请求**。
     * 结构本来就在内存里（文件树或 manifest），所以这是 O(课程数 × 产件数) 的纯内存扫描，
     * 实测全库 1014 个产件在 1ms 量级——不需要索引，也不需要防抖之外的东西。
     */
    async searchTitles(query: string, signal?: AbortSignal): Promise<TitleHit[]> {
      const q = query.trim().toLowerCase()
      if (!q) return []

      const hits: TitleHit[] = []
      for (const course of await getCourses()) {
        signal?.throwIfAborted()
        if (course.title.toLowerCase().includes(q) || course.id.toLowerCase().includes(q)) {
          hits.push({ courseId: course.id, courseTitle: course.title, kind: 'course', title: course.title })
        }
        for (const kind of ['volumes', 'notes', 'subtitles'] as const) {
          for (const doc of course[kind]) {
            if (doc.title.toLowerCase().includes(q)) {
              hits.push({ courseId: course.id, courseTitle: course.title, documentId: doc.id, kind: doc.kind, title: doc.title })
            }
          }
        }
      }
      return hits
    },

    async loadDocument(id: DocumentId, signal?: AbortSignal): Promise<string> {
      // 期望大小来自已加载的结构（文件树 / manifest）——缓存靠它判断记录是否已失效。
      // 逐字稿也要查：它是只有 count 的那类产件，漏掉会让它的缓存永不失效。
      const expectedSize = (await getCourses())
        .flatMap((c) => [...c.volumes, ...c.notes, ...c.subtitles])
        .find((d) => d.id === id)?.size

      if (cache) {
        const hit = await cache.get(id, expectedSize)
        if (hit !== undefined) return hit
      }
      const text = await fetchContent(id, signal)
      // 异步写入缓存，不阻塞网络并发队列的下一次抓取
      if (cache) void cache.set(id, text).catch(() => undefined)
      return text
    },
  }
}
