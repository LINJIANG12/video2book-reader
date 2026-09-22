/**
 * 正文缓存（IndexedDB）。
 *
 * 为什么静态站要有它：**已读过的册应当离线可读**（docs/03 §2.3）。这不是"记录"，
 * 而是内容缓存——所以它落在 IndexedDB；而**进度、书签这类阅读状态一律只在内存**
 * （关掉即无记录，这正是 docs/03 §11.1 说的「阉割记录」）。
 *
 * 失效规则：记录里存字节数，读取时与**文件树/manifest 给的期望大小**比对，
 * 不一致即视为失效并重新拉取（docs/02 §9）。大小是免费拿到的，所以不需要额外的版本号。
 */

const DB_NAME = 'course-reader'
const STORE = 'content'
const VERSION = 1

type Record = { text: string; bytes: number; cachedAt: number }

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB 打不开'))
  })
  return dbPromise
}

export function byteLength(text: string): number {
  return new Blob([text]).size
}

export const contentCache = {
  /**
   * @param expectedSize 期望字节数（来自文件树 / manifest）。给了就校验，不匹配视为失效。
   */
  async get(id: string, expectedSize?: number): Promise<string | undefined> {
    try {
      const db = await openDb()
      const record = await new Promise<Record | undefined>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
        req.onsuccess = () => resolve(req.result as Record | undefined)
        req.onerror = () => reject(req.error ?? new Error('读取失败'))
      })
      if (!record) return undefined
      if (expectedSize !== undefined && record.bytes !== expectedSize) return undefined // 改版了
      return record.text
    } catch {
      return undefined // 隐私模式 / 配额 / 被清理：静默降级为不缓存，不影响阅读
    }
  },

  async set(id: string, text: string): Promise<void> {
    try {
      const db = await openDb()
      const record: Record = { text, bytes: byteLength(text), cachedAt: Date.now() }
      await new Promise<void>((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(record, id)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error ?? new Error('写入失败'))
      })
    } catch {
      /* 写不进去就算了，不影响阅读 */
    }
  },
}

/** 内存缓存：IndexedDB 不可用时的兜底，接口与上面一致 */
export function createMemoryCache() {
  const map = new Map<string, string>()
  return {
    get: async (id: string) => map.get(id),
    set: async (id: string, text: string) => void map.set(id, text),
  }
}
