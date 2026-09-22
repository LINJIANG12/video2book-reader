/**
 * 结构不变量校验（`docs/00 §4` 第 3/4/5 条，`docs/01 §8`）。
 *
 * ## 为什么需要它
 *
 * 「阅读器不许依赖 agent / 插件 / 壳」是**最容易在日常开发里悄悄破坏**的一条：
 * 某天有人为了省事在 `packages/reader` 里 `import { createThread } from '../../packages/agent'`，
 * 一切照常构建、照常运行，直到要做静态版时才发现阅读器再也摘不干净了。
 * 这个脚本就是那条纪律的执行机制——没有它，纪律只是纸面承诺。
 *
 * ## 为什么是黑名单，而不是 `docs/01 §8` 字面上的「白名单」
 *
 * 白名单在这里是维护税：每加一种 Shiki 语言、每换一个 markdown 插件都要改脚本，
 * 于是脚本很快会被人为了让构建通过而放宽——最后等于没验。
 * 真正要守的是**禁止依赖的方向**（agent / 插件 / 壳 / Node 内置），
 * 所以这里拦的是方向，不是包的集合。
 *
 * ## 三件事
 *
 *   1. 扫 `packages/reader` 与 `apps/reader-web` 的 import，比对禁止清单
 *   2. 把 `plugins/` 临时移开再构建一次（不变量 4/5：删掉插件仍能构建）
 *   3. 扫静态版产物里的运行时关键词（**不扫类型名**——TS 类型编译后已被擦除，扫它等于没验）
 *
 *   node scripts/verify-boundaries.mjs
 *   pnpm verify:boundaries
 */
import { readFileSync, readdirSync, statSync, existsSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const check = (ok, label, detail = '') => {
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed += 1
}
const rel = (p) => relative(ROOT, p).split(sep).join('/')

// ─────────────────────────────────────────────────────────────
// 1) import 方向检查
// ─────────────────────────────────────────────────────────────

/**
 * 禁止出现的 import 目标。每条都对应一个结构不变量，不是泛泛的"整洁"：
 *   plugins/        不变量 4：删掉整个 plugins/ 项目仍能跑 → 核心包不许反向依赖它
 *   packages/agent  不变量 5：静态版没有 AI → 阅读器不许有一丝 agent 依赖
 *   @tauri-apps/、@capacitor/、electron  不变量 3：阅读器不认识任何壳
 *
 * 注意作用域：`@app/*` 只对**阅读器包**禁止（它必须是最内层，不得依赖任何其他工作区包），
 * 而 apps/reader-web **本来就应该** import `@app/reader`——那是它的消费者身份，不是违规。
 */
const RULES = {
  plugins: { re: /(^|\/)plugins\//, why: '插件目录（不变量 4）' },
  agent: { re: /(^|\/)packages\/agent/, why: 'agent 运行时（不变量 5）' },
  workspace: { re: /^@app\//, why: '其他工作区包——阅读器必须是最内层' },
  shell: { re: /^@tauri-apps\/|^@capacitor\/|^electron$/, why: '壳（不变量 3）' },
  nodeBuiltin: { re: /^node:/, why: 'Node 内置模块——这份代码要能在浏览器里跑' },
}

/**
 * 每个目标各自适用哪些规则。
 * `node:*` 不适用于 `vite.config.ts`——那是**构建期**在 Node 里跑的配置，
 * 用 `node:path` 天经地义。把构建配置也按运行时代码要求，只会制造噪音。
 */
const TARGETS = [
  {
    name: 'packages/reader',
    dir: join(ROOT, 'packages/reader/src'),
    rules: ['plugins', 'agent', 'workspace', 'shell', 'nodeBuiltin'],
  },
  {
    name: 'apps/reader-web',
    dir: join(ROOT, 'apps/reader-web/src'),
    rules: ['plugins', 'agent', 'shell', 'nodeBuiltin'],
  },
  {
    name: 'apps/reader-web 构建配置',
    files: [join(ROOT, 'apps/reader-web/vite.config.ts')],
    rules: ['plugins', 'agent', 'shell'],
  },
]

/**
 * 一次扫出四类依赖写法：
 *   from 'x'          import / export ... from
 *   import 'x'        副作用导入（**最容易被漏掉的一类**，负向测试就是靠它抓出过漏洞）
 *   import('x')       动态导入
 *   require('x')
 *
 * 刻意用正则而不是 TS 编译器 API：这是本地纪律脚本，不是安全边界。
 * 上限（刻意简化，写在这里以免被误当成完备）：注释或字符串里恰好写出 `from 'x'` 会误报；
 * 字符串拼接出的动态导入抓不到——后者由第 3 步的产物扫描兜住。
 */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

function collectSources(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(entry)) out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

console.log('══ 1/3  import 方向')
let scannedFiles = 0
let scannedImports = 0
const violations = []

for (const t of TARGETS) {
  const files = t.files ? t.files.filter((f) => existsSync(f)) : collectSources(t.dir)

  for (const file of files) {
    scannedFiles += 1
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(IMPORT_RE)) {
      scannedImports += 1
      const spec = m[1]
      // 相对路径先解析成「从仓库根算起」的形式，才能统一判断依赖方向
      const resolved = spec.startsWith('.') ? rel(join(dirname(file), spec)) : spec
      for (const key of t.rules) {
        const rule = RULES[key]
        if (rule.re.test(resolved)) violations.push(`${rel(file)} → ${spec}（${rule.why}）`)
      }
    }
  }
  console.log(`   · ${t.name}：${files.length} 个文件`)
}

// 扫描面为空会让"全绿"变成假绿——这类脚本最危险的失效方式就是它自己悄悄不工作了
check(scannedFiles >= 10, `已扫描源文件数 ≥ 10`, `${scannedFiles} 个`)
check(scannedImports >= 30, `已扫描 import 数 ≥ 30`, `${scannedImports} 条`)
check(violations.length === 0, '无越界依赖', violations.length ? '' : `比对 ${Object.keys(RULES).length} 条规则`)
for (const v of violations) console.log(`       ✗ ${v}`)

// ─────────────────────────────────────────────────────────────
// 2) 移开 plugins/ 后仍能构建（不变量 4）
// ─────────────────────────────────────────────────────────────

console.log('\n══ 2/3  删掉 plugins/ 仍能构建')
const pluginsDir = join(ROOT, 'plugins')
const stashDir = join(ROOT, 'plugins.__verify_stash__')
const hasPlugins = existsSync(pluginsDir)

if (!hasPlugins) console.log('   · plugins/ 不存在 —— 当前已经是"删掉插件"的状态')

/** shell: true 是因为 Windows 上 pnpm 是 .cmd；参数全是字面量，没有注入面 */
function run(args, label) {
  const res = spawnSync('pnpm', args, { cwd: ROOT, shell: true, stdio: 'pipe', encoding: 'utf8' })
  const ok = res.status === 0
  check(ok, label)
  if (!ok) {
    console.log((res.stdout + res.stderr).trim().split('\n').slice(-15).map((l) => `       ${l}`).join('\n'))
  }
  return ok
}

try {
  if (hasPlugins) renameSync(pluginsDir, stashDir)
  run(['--filter', '@app/reader-web', 'build'], '移开 plugins/ 后 @app/reader-web 构建通过')
} finally {
  // 无论构建成功与否都要放回去——脚本失败不能顺手弄丢用户的插件源码
  if (hasPlugins && existsSync(stashDir)) renameSync(stashDir, pluginsDir)
}

// ─────────────────────────────────────────────────────────────
// 3) 产物关键词扫描（不变量 5）
// ─────────────────────────────────────────────────────────────

console.log('\n══ 3/3  静态版产物无 AI / 划词残留')

/**
 * 扫**运行时符号与关键词**，不扫类型名：
 * TypeScript 的类型在编译后已被擦除，扫类型名等于永远通过（docs/01 §8）。
 *
 * 关键词表的两点考据（都是实测踩出来的，别照抄直觉）：
 *   · 不要收 `Bearer`：阅读器自己就合法地用着它——`packages/reader/src/content/github-source.ts`
 *     要给 `api.github.com` 传限流令牌。一个会在正常代码上报警的检查会被放宽，最后等于没验。
 *   · `selectionchange` / `getSelection` 会命中 react-dom 自身（第三方），
 *     所以下面按 sourcemap 归因，只对**我们自己的源码**判负。
 */
const KEYWORDS = ['selectionchange', 'getSelection', 'apiKey', 'chat/completions', 'x-api-key']

const distDir = join(ROOT, 'apps/reader-web/dist')
const ownHits = []
const vendorHits = new Map()
let distFiles = 0
let distBytes = 0
let mappedSources = 0

if (!existsSync(distDir)) {
  check(false, '产物目录存在（第 2 步应当已构建）', distDir)
} else {
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else distFiles += 1, (distBytes += statSync(p).size)
    }
  }
  walk(distDir)

  /**
   * 归因走 sourcemap：把每个关键词命中的**原始源码文件**找出来。
   * 只有命中在我们自己的源码里才算违规；命中在 `node_modules` 里的是第三方噪音，
   * 单独打印出来——既不误报，也不隐瞒（读者能看见"这个关键词确实在产物里，但来自依赖"）。
   */
  for (const entry of readdirSync(join(distDir, 'assets'))) {
    if (!entry.endsWith('.js.map')) continue
    let map
    try {
      map = JSON.parse(readFileSync(join(distDir, 'assets', entry), 'utf8'))
    } catch {
      continue
    }
    for (let i = 0; i < map.sources.length; i += 1) {
      const content = map.sourcesContent?.[i]
      if (!content) continue
      mappedSources += 1
      const source = map.sources[i]
      const isVendor = source.includes('node_modules')
      for (const kw of KEYWORDS) {
        if (!content.includes(kw)) continue
        if (isVendor) vendorHits.set(kw, [...new Set([...(vendorHits.get(kw) ?? []), source.split('node_modules/').pop()])])
        else ownHits.push(`${source} 含 "${kw}"`)
      }
    }
  }

  check(distFiles >= 5, `产物文件数 ≥ 5`, `${distFiles} 个 / ${(distBytes / 1024).toFixed(0)} KB`)
  check(mappedSources >= 50, `已归因的源文件数 ≥ 50`, `${mappedSources} 个（来自 sourcemap）`)
  check(ownHits.length === 0, `我们自己的源码里无 ${KEYWORDS.length} 个关键词`, ownHits.length ? '' : KEYWORDS.join(' · '))
  for (const h of ownHits) console.log(`       ✗ ${h}`)
  for (const [kw, files] of vendorHits) {
    console.log(`   · "${kw}" 在产物里，但来自依赖（不算违规）：${files.slice(0, 2).join(', ')}`)
  }
}

console.log(`\n${failed === 0 ? '通过：结构不变量未被破坏。' : `有 ${failed} 项未通过。`}`)
process.exitCode = failed === 0 ? 0 : 1
