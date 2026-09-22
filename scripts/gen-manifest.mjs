/**
 * 从课程仓生成静态站用的 `manifest.json`（**只含结构，不含正文**）。
 *
 * 为什么静态站要在构建期生成它（而不是运行时取 GitHub API）：
 *   `api.github.com` 在国内网络下经常不可达或极慢。若站点运行时依赖它，
 *   **书架直接出不来——这与站点托管在哪个平台无关**。
 *   构建期取一次树、随站点发布，运行时只需要能从 CDN 拉到单册正文即可。
 *   代价是新课程要等下一次重建才出现（定时重建，最多滞后一天），对课程库完全够。
 *
 * 桌面版不用它（运行时取树），因为桌面版不能要求"新增课程必须重新发版"。
 *
 * **派生逻辑只有一份**：课程结构怎么从文件树派生，全在
 * `packages/reader/src/content/derive.ts`（构建期与运行期共用）。本脚本只负责
 * 「取树 / 取根 README / 组装 manifest 外壳 / 写文件」，不再重复实现任何派生规则——
 * 两份实现一定会漂移，表现是"网页书架和桌面书架不一致"，且不报错。
 *
 *   node scripts/gen-manifest.mjs
 *
 * 环境变量：
 *   COURSES_REPO   默认 LINJIANG12/video2book-courses
 *   GITHUB_TOKEN   可选；GitHub API 未认证限流 60 次/小时，CI 里建议给
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { deriveCourses, parseRootReadme } = await import('../packages/reader/src/content/derive.ts')

/**
 * Node 的 fetch（undici）**默认不读 HTTPS_PROXY**，而 curl / 浏览器都读。
 * 后果是同一台机器上 curl 能拿到 jsDelivr、Node 却报 ECONNREFUSED，看起来像"网络玄学"。
 * 脚本内设置这一行是有效的（dispatcher 在每次 fetch 时才创建，不是进程启动时）。
 */
process.env.NODE_USE_ENV_PROXY = '1'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'apps/reader-web/public/manifest.json')

const REPO = process.env.COURSES_REPO ?? 'LINJIANG12/video2book-courses'
const REF = process.env.COURSES_REF ?? 'main'
const [OWNER, NAME] = REPO.split('/')
if (!OWNER || !NAME) throw new Error(`COURSES_REPO 格式应为 owner/name，收到：${REPO}`)

const API = `https://api.github.com/repos/${OWNER}/${NAME}`
const authHeaders = (extra) => (process.env.GITHUB_TOKEN ? { ...extra, authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : extra)

async function fetchTree() {
  const res = await fetch(`${API}/git/trees/${REF}?recursive=1`, { headers: authHeaders({ accept: 'application/vnd.github+json' }) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`取文件树失败：HTTP ${res.status} ${res.statusText}\n${body.slice(0, 400)}`)
  }
  const json = await res.json()
  if (json.truncated) {
    // 宁可报错也不要静默产出不完整的书架
    throw new Error('GitHub 返回的树被截断了（truncated=true），需要改为逐目录取树')
  }
  return json.tree
}

/**
 * 取根 README，交给 `parseRootReadme` 解析出策展顺序与展示文案。
 * best-effort：解析失败只影响卡片上的一行字与排序，不影响任何功能（docs/03 §2.3）。
 *
 * 走 api.github.com 而不是 jsDelivr：实测本机 jsDelivr 需要代理、api 直连即可，
 * 构建期少一个网络依赖就少一类"在我这儿能跑、在 CI 上挂"的问题。
 */
async function fetchRootReadme() {
  try {
    const res = await fetch(`${API}/contents/README.md?ref=${REF}`, { headers: authHeaders({ accept: 'application/vnd.github.raw' }) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const readme = parseRootReadme(await res.text())
    console.log(`[manifest] 从根 README 解析到 ${readme.order.length} 门课的策展顺序`)
    return readme
  } catch (e) {
    console.warn(`[manifest] 根 README 解析失败（不影响功能，顺序退化为目录名）：${e.message}`)
    return undefined
  }
}

async function main() {
  console.log(`[manifest] 取文件树 ${OWNER}/${NAME}@${REF}`)
  const tree = await fetchTree()
  const files = tree.filter((e) => e.type === 'blob')
  console.log(`[manifest] 树上有 ${files.length} 个文件`)

  const readme = files.some((f) => f.path === 'README.md') ? await fetchRootReadme() : undefined
  const courses = deriveCourses(files, readme)

  const manifest = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: { owner: OWNER, name: NAME, ref: REF },
    stats: {
      courses: courses.length,
      volumes: courses.reduce((n, c) => n + c.volumes.length, 0),
      notes: courses.reduce((n, c) => n + c.notes.length, 0),
      subtitles: courses.reduce((n, c) => n + c.subtitleCount, 0),
      bytes: courses.reduce((n, c) => n + c.bytes, 0),
    },
    /** 性能基准与验收用：文件树中 size 最大的那一册（docs/03 §10.1 要求取最大者，不写死册名） */
    largestVolume: courses
      .flatMap((c) => c.volumes.map((v) => ({ courseId: c.id, id: v.id, size: v.size })))
      .sort((a, b) => b.size - a.size)[0],
    courses,
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const { stats, largestVolume } = manifest
  console.log(`[manifest] 写入 ${OUT}`)
  console.log(
    `[manifest] ${stats.courses} 门课 / ${stats.volumes} 册 / ${stats.notes} 篇笔记 / ${stats.subtitles} 份逐字稿 / ${(stats.bytes / 1024 / 1024).toFixed(1)} MB 文本`,
  )
  if (largestVolume) {
    console.log(`[manifest] 最大册 ${(largestVolume.size / 1024).toFixed(0)} KB — ${largestVolume.id}`)
  }
}

await main()
