// Configuration electron-vite
// Gère la compilation de 3 cibles : main (Node), preload (Node), renderer (navigateur)

import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Processus principal Electron (Node.js)
  main: {
    plugins: [externalizeDepsPlugin()], // Externalise better-sqlite3 (module natif)
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },

  // Script preload (pont entre main et renderer)
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },

  // Interface React (navigateur dans Electron)
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    },
    plugins: [react()]
  }
})
