import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@app/reader/styles.css'
import 'katex/dist/katex.min.css'
import './app.css'

import { App } from './App.tsx'

const host = document.getElementById('root')
if (!host) throw new Error('#root not found')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
