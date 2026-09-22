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
 *   node scripts/gen-manifest.mjs
 *
 * 环境变量：
 *   COURSES_REPO   默认 LINJIANG12/video2book-courses
 *   GITHUB_TOKEN   可选；GitHub API 未认证限流 60 次/小时，CI 里建议给
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

const API = `https://api.github.com/repos/${OWNER}/${NAME}/git/trees/${REF}?recursive=1`

async function fetchTree() {
  const headers = { accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  const res = await fetch(API, { headers })
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

/** 从文件名解析产件类型、序号与标题 */
function parseDocName(path) {
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

/**
 * 解析课程仓根 README 的收录表格，拿到**策展顺序**与展示性文案。
 * 这是 best-effort：解析失败只影响卡片上的一行字与排序，不影响任何功能（docs/03 §2.3）。
 */
function parseRootReadme(markdown) {
  const order = []
  const meta = new Map()

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

    const title = link[1].replace(/\*\*/g, '').trim()
    order.push(id)
    meta.set(id, { title, direction: cells[2] ?? '' })
  }

  return { order, meta }
}

function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

async function main() {
  console.log(`[manifest] 取文件树 ${OWNER}/${NAME}@${REF}`)
  const tree = await fetchTree()
  const files = tree.filter((e) => e.type === 'blob')
  console.log(`[manifest] 树上有 ${files.length} 个文件`)

  const courses = new Map()

  for (const file of files) {
    const parts = file.path.split('/')
    if (parts.length < 3) continue // 根目录文件（README/RULES）跳过
    const courseId = parts[0]
    const dir = parts[1]

    if (!courses.has(courseId)) {
      courses.set(courseId, { id: courseId, volumes: [], notes: [], subtitleCount: 0, bytes: 0 })
    }
    const course = courses.get(courseId)

    if (dir === 'textbooks' && file.path.endsWith('.md')) {
      const parsed = parseDocName(file.path)
      if (!parsed) continue
      course.volumes.push({
        id: file.path,
        kind: 'volume',
        title: parsed.title,
        originIndex: parsed.originIndex,
        size: file.size ?? 0,
      })
      course.bytes += file.size ?? 0
    } else if (dir === 'notes' && file.path.endsWith('.md')) {
      const parsed = parseDocName(file.path)
      if (!parsed) continue
      course.notes.push({
        id: file.path,
        kind: 'note',
        title: parsed.title,
        originIndex: parsed.originIndex,
        size: file.size ?? 0,
      })
      course.bytes += file.size ?? 0
    } else if (dir === 'subtitles' && file.path.endsWith('.txt')) {
      // 逐字稿是 .txt、无阅读视图，只记数量与文件名（docs/03 §2.1）
      course.subtitleCount += 1
    }
  }

  // 取根 README 的策展顺序与展示文案。
  // 走 api.github.com 而不是 jsDelivr：实测本机 jsDelivr 需要代理、api 直连即可，
  // 构建期少一个网络依赖就少一类"在我这儿能跑、在 CI 上挂"的问题。
  let readmeOrder = { order: [], meta: new Map() }
  if (files.some((f) => f.path === 'README.md')) {
    try {
      const headers = { accept: 'application/vnd.github.raw' }
      if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
      const res = await fetch(`https://api.github.com/repos/${OWNER}/${NAME}/contents/README.md?ref=${REF}`, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      readmeOrder = parseRootReadme(await res.text())
      console.log(`[manifest] 从根 README 解析到 ${readmeOrder.order.length} 门课的策展顺序`)
    } catch (e) {
      console.warn(`[manifest] 根 README 解析失败（不影响功能，顺序退化为目录名）：${e.message}`)
    }
  }

  const list = [...courses.values()].map((c) => {
    const meta = readmeOrder.meta.get(c.id)
    return {
      ...c,
      title: meta?.title ?? c.id,
      direction: meta?.direction ?? '',
      volumes: c.volumes.sort((a, b) => a.originIndex - b.originIndex),
      notes: c.notes.sort((a, b) => a.originIndex - b.originIndex),
    }
  })

  // 策展顺序优先；README 里没有的（新增课程还没更新 README）追加到后面，按目录名排
  const rank = new Map(readmeOrder.order.map((id, i) => [id, i]))
  list.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER
    return ra !== rb ? ra - rb : a.id.localeCompare(b.id, 'zh')
  })

  const manifest = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: { owner: OWNER, name: NAME, ref: REF },
    stats: {
      courses: list.length,
      volumes: list.reduce((n, c) => n + c.volumes.length, 0),
      notes: list.reduce((n, c) => n + c.notes.length, 0),
      subtitles: list.reduce((n, c) => n + c.subtitleCount, 0),
      bytes: list.reduce((n, c) => n + c.bytes, 0),
    },
    /** 性能基准与验收用：文件树中 size 最大的那一册（docs/03 §10.1 要求取最大者，不写死册名） */
    largestVolume: list
      .flatMap((c) => c.volumes.map((v) => ({ courseId: c.id, id: v.id, size: v.size })))
      .sort((a, b) => b.size - a.size)[0],
    courses: list,
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
