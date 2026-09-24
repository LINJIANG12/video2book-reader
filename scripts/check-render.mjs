/**
 * 渲染管线的可运行检查：拿**真实内容**跑完整条纯管线（mdast → hast），然后对结构做断言。
 *
 * 为什么断言在 hast 上而不是 HTML 字符串上：hast 是结构化的，断言更稳、更好读，
 * 而且这条管线是纯函数，**Node 能直接跑**（`.tsx` 需要 JSX 转换，Node 跑不了，
 * 所以 React 那一层留给浏览器验）。这样这个脚本既能当回归测试，又不引入测试框架。
 *
 *   node scripts/check-render.mjs
 *
 * 环境变量：
 *   CHECK_REPO    默认 LINJIANG12/video2book-courses
 *   CHECK_LOCAL   设为本地 clone 目录则直接读本地文件（更快、可离线）
 */
process.env.NODE_USE_ENV_PROXY = '1' // Node 的 fetch 默认不读 HTTPS_PROXY，见 scripts/gen-manifest.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { splitDocument } = await import('../packages/reader/src/model/split-document.ts')
const { transformDocument } = await import('../packages/reader/src/markdown/transform.ts')

const REPO = process.env.CHECK_REPO ?? 'LINJIANG12/video2book-courses'
const LOCAL = process.env.CHECK_LOCAL ?? null
const [owner, repo] = REPO.split('/')

/**
 * 用例。expectedChapters 是**回归护栏**：这些数字是拿真实内容核对过的，
 * 变了就说明拆分逻辑动了（例如又退回到"用正则扫行找标题"）。
 */
const CASES = [
  {
    name: '晚期批次 + 嵌套围栏泄漏（已知内容缺陷）',
    path: '计算机/前端/pink老师-AI前端入门/textbooks/模块02_HTML5语义结构与Trae AI开发环境（P14-P23）_精读全书.md',
    expectedChapters: 11,
    // 这一册的 markdown 示例里嵌了 html 示例，而 CommonMark **不支持嵌套围栏**：
    //   2702 ```markdown  ← 外层开
    //   2716 ```html      ← 内层开
    //   2723 ```          ← 按标准，这行关掉的是【外层】围栏
    //   2735 ## 3. 本地化资源配置规约  ← 于是它泄漏成了真标题
    // 阅读器遵循 CommonMark（与 GitHub / VS Code 一致），所以它确实会多出这一章。
    // **这是内容侧缺陷，修法是生成时给外层用更长的围栏（````）**，不该由阅读器用启发式去猜。
    knownLeakedChapter: '3. 本地化资源配置规约',
  },
  {
    name: '围栏里有一整屏菜单示意图',
    path: '计算机/编程语言/黑马程序员-Python-AI/textbooks/模块09_数据容器：元组、集合、字典与容器选型对比_精读全书.md',
    expectedChapters: 11,
    note: '围栏内有 6 行「##  购物车系统  ##」，绝不能算成章',
  },
  {
    name: '导读残缺（正文比导读多 3 章）',
    path: '心理与哲学/心理学/变态心理学/北京大学-变态心理学/textbooks/模块06_临床病例深度讨论与跨障碍机制研讨_精读全书.md',
    expectedChapters: 6,
    note: '导读只列 3 条，但正文有 6 章 —— 切分以正文为准（已核实这 6 个都是真标题，不在代码块内）',
  },
  {
    name: '常规册（晚期格式，章头有 BLK）',
    path: '计算机/计算机基础/操作系统/南京大学-操作系统原理/textbooks/模块01_操作系统导论与 AI 时代的系统视角_精读全书.md',
    expectedChapters: 4,
  },
  {
    name: '公式定界符写错导致吞章（护栏回归）',
    path: '计算机/数据库/MySQL数据库入门到大牛/textbooks/模块18_范式理论、数据库设计与调优策略_精读全书.md',
    expectedChapters: 10,
    // 源文件里一块展示公式的收尾 `$$` 写在了行尾（1368 行 `eq 25.5$$`），
    // 按 micromark 的规则不构成收尾 —— 那块公式一路开到 3094 行，吞掉 1700 余行与 6 个章标题。
    // 没有护栏时这一册只能切出 5 章（章数从 1137 掉到 1109，全库 28 条导读条目失配）。
    // math-guard 把失控区域**重新解析**并恢复章结构，这里就是那次修复的回归护栏。
    expectMathGuard: true,
  },
]

async function readDoc(path) {
  if (LOCAL) return readFileSync(join(LOCAL, path), 'utf8')
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/${encoded}`)
  if (!res.ok) throw new Error(`取内容失败 HTTP ${res.status}`)
  return res.text()
}

/** 收集 hast 里所有 element 节点 */
function elements(node, out = []) {
  if (node && node.type === 'element') out.push(node)
  for (const child of node?.children ?? []) elements(child, out)
  return out
}

let failed = 0
const check = (ok, label, detail = '') => {
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed += 1
}

for (const c of CASES) {
  console.log(`\n══ ${c.name}`)
  console.log(`   ${c.path}`)
  if (c.note) console.log(`   备忘：${c.note}`)

  const md = await readDoc(c.path)
  const doc = splitDocument(md)

  check(doc.chapters.length === c.expectedChapters, `章数 = ${c.expectedChapters}`, `实际 ${doc.chapters.length}`)
  check(doc.warnings.length === 0, '无告警', doc.warnings.join(' / '))

  // 代码围栏内的内容绝不能混进章列表
  const suspicious = doc.chapters.filter((ch) => /对应 h2|购物车系统/.test(ch.title))
  check(suspicious.length === 0, '围栏内的假标题未混进章列表', suspicious.map((s) => s.title).join(' | '))

  // 已知内容缺陷：嵌套围栏泄漏出来的那一章必须仍是它，换了名字说明规则动了
  if (c.knownLeakedChapter) {
    const leaked = doc.chapters.find((ch) => ch.title === c.knownLeakedChapter)
    check(Boolean(leaked), '已知泄漏章仍被识别为章（内容侧缺陷，见用例注释）', c.knownLeakedChapter)
  }

  // 公式护栏：失控公式必须被拦下，且**章结构要被重解析救回来**（否则章数断言已经失败了）
  if (c.expectMathGuard) {
    const guardNote = doc.notes.find((n) => n.includes('公式护栏'))
    check(Boolean(guardNote), '公式护栏已拦下失控公式', guardNote?.slice(0, 70) ?? '')
  }

  const { parts, result } = transformDocument(doc.tree, doc.parts)
  const all = parts.flatMap((p) => elements(p))

  // 块锚点
  const blockIds = all.map((e) => e.properties?.['data-block-id']).filter(Boolean)
  check(blockIds.length > 10, '块锚点已生成', `${blockIds.length} 个`)
  check(new Set(blockIds).size === blockIds.length, '块 id 全局唯一')

  // 大纲
  // 结构自 2026-09 起是**四层树**：册标题(H1) 是唯一的根，章(H2) 挂在它下面，节/小节再往下。
  // 旧断言是「大纲条数 = 章数」（那时只有两层平铺），改成按 level 数。
  const flatOutline = (list, out = []) => {
    for (const n of list) {
      out.push(n)
      flatOutline(n.children, out)
    }
    return out
  }
  const outlineAll = flatOutline(result.outline)
  const chapterNodes = outlineAll.filter((n) => n.level === 2)
  check(chapterNodes.length === doc.chapters.length, '大纲里的章数 = 章数', `${chapterNodes.length} vs ${doc.chapters.length}`)
  check(result.outline.every((n) => n.level === 1 || n.level === 2), '顶层只有册标题与章', `顶层 ${result.outline.length} 个`)

  // 册标题进大纲（H1）—— 左栏要能一眼看出"在读哪一册"
  const rootTitle = result.outline.find((n) => n.level === 1)
  check(Boolean(rootTitle), '册标题（H1）进入大纲作为根', rootTitle?.title?.slice(0, 24) ?? '（没有）')

  // 小节（H4）也要进大纲：左栏要的是 Typora 那种可下探的树
  const h4Nodes = outlineAll.filter((n) => n.level === 4)
  check(h4Nodes.length > 0, '小节（H4）已进入大纲', `${h4Nodes.length} 个`)

  // 学习要素卡片
  const callouts = all.filter((e) => e.properties?.['data-callout'])
  const srcLabels = [...md.matchAll(/^> \*\*([^*]{1,16})\*\*\s*[：:]/gm)].map((m) => m[1])
  check(callouts.length > 0, '学习要素标注已渲染', `${callouts.length} 个（源里 ${srcLabels.length} 处）`)
  const kinds = new Set(callouts.map((e) => e.properties['data-callout']))
  check(callouts.every((e) => e.properties.className?.includes('callout')), '每个卡片都带样式类')
  console.log(`     分类分布：${[...kinds].join(' / ') || '（无）'}`)

  // 多行册首元信息必须解构成 label/value 表（全库 158 册每册一处；旧实现只认第一行）
  const rowTables = callouts.filter((e) => e.properties.className?.includes('callout-rows'))
  check(rowTables.length === 1, '册首元信息解构成一张行表', `${rowTables.length} 张`)
  if (rowTables.length === 1) {
    const dl = (rowTables[0].children ?? []).find((c) => c.type === 'element' && c.tagName === 'dl')
    const dts = dl ? (dl.children ?? []).filter((c) => c.tagName === 'dt') : []
    const dds = dl ? (dl.children ?? []).filter((c) => c.tagName === 'dd') : []
    check(dts.length >= 2 && dts.length === dds.length, '行表每行都是 label/value 成对', `${dts.length} 行`)
    check(!rowTables[0].properties['data-label'], '行表不再挂单个胶囊标签（否则只显示第一行）')
    console.log(`     元信息行：${dts.map((d) => d.children?.[0]?.value).join(' / ')}`)
  }

  // 卡片的标签文字里不该再残留 **加粗**（避免既显示胶囊又显示加粗）
  const leakedBold = callouts.filter((e) =>
    elements(e).some((n) => n.tagName === 'strong' && /^(定义|结论|提示|易错点|注意|承前启后)$/.test((n.children?.[0]?.value ?? '').trim())),
  )
  check(leakedBold.length === 0, '卡片内未残留重复的加粗标签')

  // 公式
  const hasMath = /\$[^$\n]+\$/.test(md)
  const katex = all.filter((e) => String(e.properties?.className ?? '').includes('katex'))
  if (hasMath) check(katex.length > 0, 'KaTeX 已渲染', `${katex.length} 个节点`)
  else check(true, '本册无行内公式（跳过 KaTeX 断言）')

  // 代码块保持为 pre（未高亮时是纯文本，不是空白）
  const pre = all.filter((e) => e.tagName === 'pre')
  check(pre.length > 0, '代码块保持为 <pre> 待懒高亮', `${pre.length} 个`)

  // 坏图片降级
  if (/!\[[^\]]*\]\([^)]*\)/.test(md)) {
    const img = all.filter((e) => e.tagName === 'img')
    const alt = all.filter((e) => e.tagName === 'span' && String(e.properties?.className).includes('broken-image'))
    check(img.length === 0 || alt.length > 0, '坏图片未被当作可用图片渲染', `img ${img.length} / 占位 ${alt.length}`)
  }

  // 章节标题里不该出现代码围栏的内容
  const bogusHeadings = outlineAll.filter((o) => /##|```/.test(o.title))
  check(bogusHeadings.length === 0, '大纲标题里没有围栏残留')
}

console.log(`\n${failed === 0 ? '全部通过。' : `有 ${failed} 项未通过。`}`)
process.exitCode = failed === 0 ? 0 : 1
