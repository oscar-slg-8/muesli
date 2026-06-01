// Point d'entrée React — monte l'application dans le DOM
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Élément #root introuvable dans le HTML')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
