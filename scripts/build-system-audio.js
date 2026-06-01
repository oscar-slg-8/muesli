#!/usr/bin/env node
// Compile SystemAudioCaptureCLI.swift en sélectionnant automatiquement
// le SDK macOS le plus récent compatible avec le compilateur Swift installé.
//
// Problème résolu : xcrun --sdk macosx peut pointer vers un SDK dont la version
// Swift est plus récente que le compilateur installé (ex: SDK Swift 6.2 vs swiftc 6.1.2).
// Ce script choisit le SDK le plus récent dont la version Swift ≤ compilateur.

const { execSync, spawnSync } = require('child_process')
const { readdirSync, existsSync } = require('fs')
const { join } = require('path')

const SDK_ROOTS = [
  '/Library/Developer/CommandLineTools/SDKs',
  '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs'
]

// Version du compilateur Swift installé (ex: "6.1.2")
function getSwiftVersion() {
  try {
    const out = execSync('xcrun swiftc --version 2>&1', { encoding: 'utf8' })
    const m = out.match(/Swift version (\d+\.\d+(?:\.\d+)?)/)
    return m ? m[1].split('.').map(Number) : [0, 0, 0]
  } catch {
    return [0, 0, 0]
  }
}

function versionTuple(s) {
  return s.split('.').map(Number)
}

function versionLe(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0,
      bv = b[i] ?? 0
    if (av < bv) return true
    if (av > bv) return false
  }
  return true
}

// Lire la version Swift embarquée dans un SDK
function getSdkSwiftVersion(sdkPath) {
  const swiftmodule = join(sdkPath, 'usr/lib/swift/Swift.swiftmodule')
  if (!existsSync(swiftmodule)) return null
  try {
    // Le .swiftinterface contient "swift-compiler-version: Apple Swift version X.Y.Z"
    const files = readdirSync(swiftmodule).filter(f => f.endsWith('.swiftinterface'))
    if (!files.length) return null
    const content = require('fs').readFileSync(join(swiftmodule, files[0]), 'utf8').slice(0, 2000)
    const m = content.match(/swift-compiler-version:.*Swift version (\d+\.\d+(?:\.\d+)?)/)
    return m ? versionTuple(m[1]) : null
  } catch {
    return null
  }
}

// Lister tous les SDKs macOS disponibles
function findCompatibleSdk(compilerVersion) {
  const candidates = []
  for (const root of SDK_ROOTS) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('MacOSX') || !entry.endsWith('.sdk')) continue
      const sdkPath = join(root, entry)
      const sdkSwiftVersion = getSdkSwiftVersion(sdkPath)
      if (!sdkSwiftVersion) continue
      if (versionLe(sdkSwiftVersion, compilerVersion)) {
        const m = entry.match(/MacOSX(\d+\.\d+)\.sdk/)
        const macosVersion = m ? versionTuple(m[1]) : [0, 0]
        candidates.push({ sdkPath, macosVersion, sdkSwiftVersion })
      }
    }
  }
  // Trier par version macOS décroissante → prendre le plus récent compatible
  candidates.sort((a, b) => {
    for (let i = 0; i < 2; i++) {
      if (b.macosVersion[i] !== a.macosVersion[i]) return b.macosVersion[i] - a.macosVersion[i]
    }
    return 0
  })
  return candidates[0]?.sdkPath ?? null
}

const compilerVersion = getSwiftVersion()
console.log(`[build:system-audio] Swift compiler: ${compilerVersion.join('.')}`)

const sdkPath = findCompatibleSdk(compilerVersion)
if (!sdkPath) {
  console.error(
    '[build:system-audio] Aucun SDK macOS compatible trouvé. Installe Xcode ou Command Line Tools.'
  )
  process.exit(1)
}
console.log(`[build:system-audio] SDK sélectionné: ${sdkPath}`)

const result = spawnSync(
  'xcrun',
  [
    'swiftc',
    '-sdk',
    sdkPath,
    '-framework',
    'AVFoundation',
    '-framework',
    'CoreAudio',
    '-framework',
    'Foundation',
    '-target',
    'arm64-apple-macos14.2',
    'resources/SystemAudioCaptureCLI.swift',
    '-o',
    'resources/system-audio-capture'
  ],
  { stdio: 'inherit' }
)

if (result.status !== 0) {
  console.error('[build:system-audio] Compilation échouée')
  process.exit(result.status ?? 1)
}
console.log('[build:system-audio] Binaire compilé → resources/system-audio-capture')
