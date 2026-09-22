/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COURSES_REPO?: string
  readonly VITE_COURSES_REF?: string
  /** 'runtime' = 先实时取树（失败回退 manifest）；缺省 = 先读构建期 manifest（失败回退取树） */
  readonly VITE_CONTENT_PREFER?: string
  readonly VITE_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
