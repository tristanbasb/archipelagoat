import './design/fonts.css'
import './design/tokens.css'
import './design/base.css'
import './design/effects.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root element is missing from index.html')

// App holds every provider: queries, i18n, effects, toasts and the hash router.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
