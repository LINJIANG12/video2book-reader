/**
 * NetPort 在 PC 壳里的实现（M0 的最小版本）。
 *
 * 这份代码回答一个具体问题：**Tauri 的 http 插件能不能把响应体当增量流读出来？**
 * 设计里 LLM 的逐字输出全靠它（`01` §3.1 / `00` §10 已查实返回真正的 ReadableStream，这里做冒烟确认）。
 *
 * Tauri 侧走 @tauri-apps/plugin-http：
 *   - 请求从 **Rust 侧**发出，不受 WebView 的 CORS 限制
 *   - 这正是 `00` §3 选 Tauri 的硬理由之一（要连用户自填的 127.0.0.1 端点）
 * 浏览器侧走原生 fetch：让这套 UI 能直接在浏览器里调（开发期效率），也对应 M3 静态版的实现。
 *
 * M1 会把这份实现搬进 packages/app 的端口装配层；现在先留在壳里，因为它还没有消费者之外的角色。
 */

export type NetRequest = {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export type NetResponse = {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: ReadableStream<Uint8Array> | null
}

/** 当前跑在 Tauri 里还是浏览器里 */
export const runtime: 'tauri' | 'browser' =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'tauri' : 'browser'

async function resolveFetch(): Promise<typeof fetch> {
  if (runtime === 'tauri') {
    // 动态 import：浏览器构建里不会把 Tauri 插件打进主包
    const mod = await import('@tauri-apps/plugin-http')
    return mod.fetch as unknown as typeof fetch
  }
  return globalThis.fetch.bind(globalThis)
}

export async function netFetch(req: NetRequest): Promise<NetResponse> {
  const doFetch = await resolveFetch()

  const res = await doFetch(req.url, {
    method: req.method ?? 'GET',
    headers: req.headers,
    body: req.body,
    signal: req.signal,
  })

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers,
    body: res.body,
  }
}
