#!/usr/bin/env node
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const DIST = path.join(__dirname, '..', 'node_modules', 'electron', 'dist')
const ELECTRON_APP = path.join(DIST, 'Electron.app')
const MUESLI_APP = path.join(DIST, 'Muesli.app')
const PATH_TXT = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt')
const MUESLI_ICNS = path.join(__dirname, '..', 'build', 'icon.icns')

// Déterminer quel .app existe
const APP = fs.existsSync(MUESLI_APP)
  ? MUESLI_APP
  : fs.existsSync(ELECTRON_APP)
    ? ELECTRON_APP
    : null

if (!APP) {
  console.log('[patch-electron] Aucun .app trouvé — skip')
  process.exit(0)
}

// 1. Toujours mettre l'icône à jour
if (fs.existsSync(MUESLI_ICNS)) {
  const resources = path.join(APP, 'Contents', 'Resources')
  for (const name of fs.readdirSync(resources)) {
    if (name.toLowerCase().endsWith('.icns')) {
      fs.copyFileSync(MUESLI_ICNS, path.join(resources, name))
    }
  }
  console.log('[patch-electron] Icône ✓')
}

// Si déjà renommé en Muesli.app, on a fini
if (APP === MUESLI_APP) {
  console.log('[patch-electron] Déjà patché ✓')
  process.exit(0)
}

// 2. Patch Info.plist
const PLIST = path.join(ELECTRON_APP, 'Contents', 'Info.plist')
try {
  execSync(`plutil -replace CFBundleName -string "Muesli" "${PLIST}"`)
  execSync(`plutil -replace CFBundleDisplayName -string "Muesli" "${PLIST}"`)
  execSync(`plutil -replace CFBundleIdentifier -string "com.muesli.app" "${PLIST}"`)
  execSync(`plutil -replace CFBundleExecutable -string "Muesli" "${PLIST}"`)
  console.log('[patch-electron] Info.plist ✓')
} catch (e) {
  console.warn('[patch-electron] Erreur Info.plist:', e.message)
}

// 3. Renommer le binaire
const oldBin = path.join(ELECTRON_APP, 'Contents', 'MacOS', 'Electron')
const newBin = path.join(ELECTRON_APP, 'Contents', 'MacOS', 'Muesli')
if (fs.existsSync(oldBin)) {
  fs.renameSync(oldBin, newBin)
  console.log('[patch-electron] Binaire ✓')
}

// 4. Renommer le .app
fs.renameSync(ELECTRON_APP, MUESLI_APP)
console.log('[patch-electron] Muesli.app ✓')

// 5. path.txt
fs.writeFileSync(PATH_TXT, 'Muesli.app/Contents/MacOS/Muesli')
console.log('[patch-electron] path.txt ✓')
