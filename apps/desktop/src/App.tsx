import { useCallback, useEffect, useRef, useState } from 'react'
import { netFetch, runtime } from './net-port'

const STREAM_URL = 'http://127.0.0.1:8788/stream'
const REPORT_URL = 'http://127.0.0.1:8788/report'

/** 服务端间隔 200ms；若块是"一次性到齐"的，跨度会远小于这个值 */
const EXPECTED_SERVER_INTERVAL_MS = 200
/** 跨度低于这个值，判定为"没有真正流式" */
const SPREAD_THRESHOLD_MS = 300

/**
 * 自动验收开关。两种触发方式：
 *   - URL 加 `?autotest=1`（浏览器里手测）
 *   - 构建时给 `VITE_AUTOTEST=1`（用于 `tauri dev`，不必改配置里的 devUrl）
 * 触发后跑一次并把结论回传给本地夹具，供命令行读（见 scripts/stream-echo-server.mjs）
 */
const AUTOTEST =
  new URLSearchParams(location.search).get('autotest') === '1' ||
  import.meta.env.VITE_AUTOTEST === '1'

type Chunk = {
  n: number
  /** 相对开始的时间 */
  deltaMs: number
  raw: string
}

type Verdict = {
  chunkCount: number
  firstChunkMs: number
  totalMs: number
  spreadMs: number
  pass: boolean
  note: string
}

function nowMs() {
  return performance.now()
}

export function App() {
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<Chunk[]>([])
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setRunning(true)
    setLive([])
    setVerdict(null)
    setError(null)

    const t0 = nowMs()
    const chunks: Chunk[] = []

    try {
      const res = await netFetch({
        url: STREAM_URL,
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      if (!res.body) throw new Error('响应没有 body（ReadableStream 为 null）')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // 关键：这里逐块读。如果流式是假的，下面的循环只会跑一次
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 以空行分隔事件
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const line = event.split('\n').find((l) => l.startsWith('data:'))
          if (line) {
            const raw = line.slice(5).trim()
            if (raw !== '[DONE]') {
              let n = chunks.length + 1
              try {
                n = (JSON.parse(raw) as { n: number }).n
              } catch {
                /* 非 JSON 也照样记下来 */
              }
              const chunk: Chunk = { n, deltaMs: nowMs() - t0, raw }
              chunks.push(chunk)
              setLive([...chunks])
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }

      const totalMs = nowMs() - t0
      const first = chunks[0]
      const last = chunks[chunks.length - 1]
      const firstChunkMs = first ? first.deltaMs : Number.NaN
      const spreadMs = first && last ? last.deltaMs - first.deltaMs : 0

      // 判定：要有多个块，且到达时间必须拉开
      const expectedSpread = (chunks.length - 1) * EXPECTED_SERVER_INTERVAL_MS
      const pass = chunks.length >= 2 && spreadMs >= SPREAD_THRESHOLD_MS

      const note = pass
        ? `块到达跨度 ${Math.round(spreadMs)}ms，接近预期的 ${expectedSpread}ms —— 响应体确实是增量到达的`
        : chunks.length < 2
          ? `只收到 ${chunks.length} 块，无法判断增量性`
          : `块到达跨度只有 ${Math.round(spreadMs)}ms（预期约 ${expectedSpread}ms）—— 内容像是攒齐后一次性到达，流式没有真正生效`

      setVerdict({
        chunkCount: chunks.length,
        firstChunkMs,
        totalMs,
        spreadMs,
        pass,
        note,
      })

      // 回传验收结论（失败不影响页面本身，所以单独 try）
      try {
        await netFetch({
          url: REPORT_URL,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pass,
            runtime,
            chunkCount: chunks.length,
            firstChunkMs: Math.round(firstChunkMs),
            spreadMs: Math.round(spreadMs),
            totalMs: Math.round(totalMs),
            expectedSpreadMs: expectedSpread,
            note,
          }),
        })
      } catch {
        /* 没起回传口就忽略 */
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setError('已取消')
      } else {
        setError((e as Error).message)
      }
    } finally {
      setRunning(false)
    }
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // 自动验收：给命令行留一个可执行的检查（跑 tauri dev 后看 stream-echo 的输出）
  useEffect(() => {
    if (AUTOTEST) void run()
  }, [run])

  return (
    <main>
      <header>
        <h1>M0 · NetPort 流式验证</h1>
        <p className="sub">
          把响应体当增量流读出来，是 LLM 逐字输出的前提。判据不是「读到了内容」，而是
          <strong>每块的到达时间被拉开了</strong>。
        </p>
      </header>

      <section className="meta">
        <span>
          运行环境：<code>{runtime}</code>
        </span>
        <span>
          测试端点：<code>{STREAM_URL}</code>
        </span>
        {AUTOTEST && (
          <span>
            自动验收：<code>已开启</code>
          </span>
        )}
      </section>

      <div className="actions">
        <button onClick={run} disabled={running}>
          {running ? '读取中…' : '开始验证'}
        </button>
        <button onClick={cancel} disabled={!running} className="secondary">
          取消
        </button>
      </div>

      <p className="hint">
        先运行 <code>pnpm stream-server</code> 启动本地 SSE 夹具（10 块 / 间隔 200ms）。
      </p>

      {error && <div className="error">失败：{error}</div>}

      {verdict && (
        <div className={verdict.pass ? 'verdict pass' : 'verdict fail'}>
          <strong>{verdict.pass ? '通过' : '未通过'}</strong>
          <p>{verdict.note}</p>
          <dl>
            <div>
              <dt>块数</dt>
              <dd>{verdict.chunkCount}</dd>
            </div>
            <div>
              <dt>首块延迟</dt>
              <dd>{Math.round(verdict.firstChunkMs)}ms</dd>
            </div>
            <div>
              <dt>到达跨度</dt>
              <dd>{Math.round(verdict.spreadMs)}ms</dd>
            </div>
            <div>
              <dt>总耗时</dt>
              <dd>{Math.round(verdict.totalMs)}ms</dd>
            </div>
          </dl>
        </div>
      )}

      {live.length > 0 && (
        <section>
          <h2>逐块到达</h2>
          <ol className="chunks">
            {live.map((c) => (
              <li key={`${c.n}-${c.deltaMs}`}>
                <span className="delta">{Math.round(c.deltaMs)}ms</span>
                <code>{c.raw}</code>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  )
}
