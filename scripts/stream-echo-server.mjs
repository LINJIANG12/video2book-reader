/**
 * M0 的流式验证夹具：一个最小 SSE 服务，每隔 200ms 推一块，共 10 块 + 一个结束标记。
 *
 * 用途：验证 NetPort 能把响应体当**增量流**读出来，而不是等整个 body 到齐。
 * 判据不在"能读到内容"，而在"每块的到达时间明显不同"——如果 10 块几乎同时出现，
 * 说明流式没有真正生效（这正是 M0 要排掉的风险）。
 *
 * 故意不走任何模型端点：不需要密钥、不需要网络、结果可重复。
 *
 *   node scripts/stream-echo-server.mjs        # 监听 http://127.0.0.1:8788/stream
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.STREAM_ECHO_PORT ?? 8788)
const CHUNKS = Number(process.env.STREAM_ECHO_CHUNKS ?? 10)
const INTERVAL_MS = Number(process.env.STREAM_ECHO_INTERVAL_MS ?? 200)

const server = createServer((req, res) => {
  // 浏览器路径（Vite dev server 与这里不同源）需要 CORS；Tauri 的 http 插件走 Rust 侧，不需要但无妨
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (url.pathname === '/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, chunks: CHUNKS, intervalMs: INTERVAL_MS }))
    return
  }

  /**
   * 验收回传口。前端跑完流式验证后把结论 POST 到这里，由本服务打到 stdout。
   *
   * 存在的理由：M0 的验收项是「在 Tauri 窗口里读通流式」，而那是 WebView 内部发生的事。
   * 有了这个回传口，验收就能在命令行里读出来（跑 `tauri dev` 后看本服务的输出），
   * 不需要人盯着窗口看，也不需要截图。
   */
  if (url.pathname === '/report' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let mark = 'REPORT'
      try {
        const parsed = JSON.parse(body)
        mark = parsed.pass ? 'REPORT PASS' : 'REPORT FAIL'
        console.log(`[${mark}] ${JSON.stringify(parsed)}`)
      } catch {
        console.log(`[${mark}] (非 JSON) ${body}`)
      }
      res.writeHead(204, cors)
      res.end()
    })
    return
  }

  if (url.pathname !== '/stream') {
    res.writeHead(404, { ...cors, 'content-type': 'text/plain' })
    res.end('not found — try /stream, /health, POST /report')
    return
  }

  res.writeHead(200, {
    ...cors,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // 关掉任何中间层的缓冲，否则流式会被"攒起来一次性发出"
    'x-accel-buffering': 'no',
  })

  let n = 0
  const startedAt = Date.now()

  const timer = setInterval(() => {
    n += 1
    const payload = { n, total: CHUNKS, elapsedMs: Date.now() - startedAt }
    res.write(`data: ${JSON.stringify(payload)}\n\n`)

    if (n >= CHUNKS) {
      clearInterval(timer)
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }, INTERVAL_MS)

  req.on('close', () => clearInterval(timer))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stream-echo] http://127.0.0.1:${PORT}/stream  (${CHUNKS} 块 / 间隔 ${INTERVAL_MS}ms)`)
  console.log(`[stream-echo] 健康检查 http://127.0.0.1:${PORT}/health`)
  console.log(`[stream-echo] 验收回传 POST http://127.0.0.1:${PORT}/report`)
})
