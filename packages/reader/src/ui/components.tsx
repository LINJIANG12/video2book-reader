/**
 * hast → React 的组件映射（管线末端的最后一跳）。
 *
 * 这里承担三件按需发生的事：
 *   1. 代码高亮（懒加载，见下）
 *   2. 学习要素卡片的视觉分类（callout-*，样式在 styles.css）
 *   3. 坏引用与非预期内容的优雅降级（全库只有 2 处图片引用且都是坏路径）
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

/** 语言别名映射。来源：全库围栏语言的实测分布（docs/03 §5.1） */
const LANG_ALIASES: Record<string, string> = {
  assembly: 'asm',
  x86asm: 'asm',
  asm: 'asm',
  dos: 'batch', // 内容里的 ```dos 是 DOS 批处理，Shiki 对应 batch
  cmd: 'batch', // ```cmd 同理（实测 5 处）
  shell: 'bash',
  sh: 'bash',
  js: 'javascript', // ```js 实测 7 处，不映射的话白白不高亮
  // 无语言或纯文本：**不猜语言**，按纯文本渲染（docs/03 §5.2 的默认行为）
  text: '',
  txt: '',
  plaintext: '',
  // xpath 在 Shiki 里没有语法 —— 按未知语言处理，退化为纯文本（不报错）
}

/**
 * 只引入内容里实际用到的语言。
 *
 * 为什么不 `import('shiki')` 全量：那样会把约 200 个语言语法 + 622 KB 的 oniguruma wasm
 * 都打进产物，而访客只在首次高亮时多下 232 KB(gzip) 的 wasm。这里改成
 * **JS 正则引擎（无 wasm）+ 逐语言按需 import**，dist 与访客下载量都大幅下降。
 * 语言表来自全库实测分布，新增语言只需在这里加一行。
 */
const LANG_MODULES: Record<string, () => Promise<unknown>> = {
  asm: () => import('@shikijs/langs/asm'),
  bash: () => import('@shikijs/langs/bash'),
  batch: () => import('@shikijs/langs/batch'),
  c: () => import('@shikijs/langs/c'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  python: () => import('@shikijs/langs/python'),
  sql: () => import('@shikijs/langs/sql'),
}

/** Shiki 单例：引擎只建一次，语言按需加载并常驻 */
let highlighterPromise: Promise<import('shiki/core').HighlighterCore> | null = null

async function getHighlighter() {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
    const [light, dark] = await Promise.all([
      import('@shikijs/themes/github-light'),
      import('@shikijs/themes/github-dark'),
    ])
    return createHighlighterCore({
      themes: [light, dark],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return highlighterPromise
}

async function highlight(code: string, lang: string): Promise<string | null> {
  const load = LANG_MODULES[lang]
  if (!load) return null // 未列入表的语言：保持纯文本，不报错
  try {
    const h = await getHighlighter()
    if (!h.getLoadedLanguages().includes(lang)) {
      await h.loadLanguage((await load()) as never)
    }
    return h.codeToHtml(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
    })
  } catch {
    return null
  }
}

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  const props = (node as { props?: { children?: ReactNode } }).props
  return props ? extractText(props.children) : ''
}

/**
 * 代码块：进入视口才高亮。
 *
 * 为什么必须懒加载：单册可能有上百个代码块，全量 Shiki 会让首屏明显卡（docs/03 §10.2）。
 * 未高亮时按纯文本显示（**不是空白**），滚动到附近再替换成高亮结果。
 */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [html, setHtml] = useState<string | null>(null)

  const codeProps = (children as { props?: { className?: string; children?: ReactNode } } | undefined)?.props
  const className = codeProps?.className ?? ''
  const rawLang = /language-([\w+#-]+)/.exec(className)?.[1]?.toLowerCase() ?? ''
  const lang = rawLang in LANG_ALIASES ? LANG_ALIASES[rawLang] : rawLang
  const code = typeof codeProps?.children === 'string' ? codeProps.children : extractText(children)

  useEffect(() => {
    if (!lang || !code) return
    const el = ref.current
    if (!el) return

    let cancelled = false
    const run = async () => {
      const out = await highlight(code, lang)
      if (!cancelled && out) setHtml(out)
    }

    // 视口附近就提前高亮，避免滚动时才闪烁
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          void run()
        }
      },
      { rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [lang, code])

  const label = lang ? <span className="code-lang">{lang}</span> : null

  if (html) {
    return (
      <div className="code-block" ref={ref as unknown as React.RefObject<HTMLDivElement>}>
        {label}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    )
  }

  return (
    <div className="code-block" ref={ref as unknown as React.RefObject<HTMLDivElement>}>
      {label}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** 学习要素卡片。分类由 rehype 插件给出（data-callout），这里只负责呈现 */
export function Callout({ children, className, ...props }: { children?: ReactNode; className?: string } & Record<string, unknown>) {
  const kind = (props['data-callout'] as string) ?? 'generic'
  const label = (props['data-label'] as string) ?? ''
  // **保留插件给的 className**（它带着 callout-rows 这类附加类）。
  // 早先这里直接用模板串重建 `callout callout-${kind}`，把传入的类整个丢了——
  // 于是多行元信息表的 callout-rows 在 hast 里存在、到 DOM 里消失，样式也就没落上。
  const klass = typeof className === 'string' && className ? className : `callout callout-${kind}`
  // 题干/解析/答案默认折叠——它把「读」变成「先自测再读」（docs/03 §4.2 纪律 3）
  const collapsible = kind === 'question' && /题干|解析|答案/.test(label)

  if (collapsible) {
    return (
      <details className={klass} data-callout={kind}>
        <summary>{label}</summary>
        <div className="callout-body">{children}</div>
      </details>
    )
  }

  return (
    <div className={klass} data-callout={kind}>
      {label && <span className="callout-label">{label}</span>}
      <div className="callout-body">{children}</div>
    </div>
  )
}

/** 表格：横向溢出时容器内滚动，不撑破页面宽度（docs/03 §7） */
export function Table({ children }: { children?: ReactNode }) {
  return (
    <div className="table-scroll">
      <table>{children}</table>
    </div>
  )
}

/** 图片：全库几乎都是坏引用，降级成占位而不是碎图图标（docs/03 §7） */
export function Image({ src, alt }: { src?: string; alt?: string }) {
  return (
    <span className="broken-image" title={src}>
      {alt ? `${alt} · ` : ''}
      {src ? `图片不可用（${src.slice(0, 60)}）` : '图片不可用'}
    </span>
  )
}

/** 外链：新窗口打开 */
export function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const external = Boolean(href && /^https?:/.test(href))
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
      {children}
    </a>
  )
}

/** 插进 hast→React 的组件表。键名对应 HTML 标签名 */
export const READER_COMPONENTS = {
  pre: CodeBlock,
  div: Callout,
  table: Table,
  img: Image,
  a: Link,
} as const
