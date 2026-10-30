import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { isSessionDrag } from './state/dropZone'
import './theme.css'

// A file dropped anywhere but a terminal must not navigate the window to it.
// A session dragged from the sidebar can only land on a drop layer; elsewhere it's refused (and slides back).
document.addEventListener('dragover', (e) => {
  if (!e.defaultPrevented && isSessionDrag(e.dataTransfer)) e.dataTransfer!.dropEffect = 'none'
  e.preventDefault()
})
document.addEventListener('drop', (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
