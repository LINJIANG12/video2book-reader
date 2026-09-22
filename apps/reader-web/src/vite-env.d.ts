/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COURSES_REPO?: string
  readonly VITE_COURSES_REF?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
