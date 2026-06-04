// ============================================================
// Compile le helper calendrier Swift et l'empaquette dans un .app.
//
// Pourquoi un .app ? EventKit (macOS 14+) exige une description d'usage
// (NSCalendarsFullAccessUsageDescription) dans l'Info.plist du binaire qui
// demande l'accès. Un binaire nu n'en a pas → accès refusé sans prompt.
// En plaçant le binaire dans Foo.app/Contents/MacOS/, Bundle.main résout vers
// le .app et EventKit y lit les clés d'usage.
//
// Le .app résultant (resources/CalendarHelper.app) est l'artefact embarqué
// (extraResources) et commité dans le repo.
// ============================================================

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const swift = path.join(root, 'electron', 'calendar.swift')
const plist = path.join(root, 'electron', 'calendar-Info.plist')
const appDir = path.join(root, 'resources', 'CalendarHelper.app')
const macosDir = path.join(appDir, 'Contents', 'MacOS')
const binOut = path.join(macosDir, 'calendar-helper')

function main() {
  fs.mkdirSync(macosDir, { recursive: true })

  // 1. Compilation Swift → binaire dans le bundle
  execSync(
    `xcrun swiftc -framework EventKit -framework Foundation "${swift}" -o "${binOut}"`,
    { stdio: 'inherit' }
  )

  // 2. Info.plist du bundle
  fs.copyFileSync(plist, path.join(appDir, 'Contents', 'Info.plist'))

  // 3. Signature ad-hoc du bundle
  execSync(`codesign --force --deep -s - "${appDir}"`, { stdio: 'inherit' })

  // 4. Copie de compat : binaire nu à la racine resources/ (fallback legacy)
  fs.copyFileSync(binOut, path.join(root, 'resources', 'calendar-helper'))

  console.log('✓ CalendarHelper.app généré et signé')
}

main()
