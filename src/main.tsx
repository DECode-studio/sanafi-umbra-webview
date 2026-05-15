import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app'
import { bootstrapSanafiUmbraBridge } from './bridge/sanafiUmbraBridge'

bootstrapSanafiUmbraBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
