// ============================================================
// Génère build/icon.icns à partir de build/icon.svg
// Requiert : npm install (sharp doit être installé)
// Usage : node scripts/build-icon.js
// ============================================================

const sharp = require('sharp')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.join(__dirname, '..')
const svgPath = path.join(root, 'build', 'icon.svg')
const iconsetDir = path.join(root, 'build', 'icon.iconset')
const icnsPath = path.join(root, 'build', 'icon.icns')

async function main() {
  if (!fs.existsSync(svgPath)) {
    console.error('❌ build/icon.svg introuvable')
    process.exit(1)
  }

  fs.mkdirSync(iconsetDir, { recursive: true })

  const svgBuffer = fs.readFileSync(svgPath)

  const sizes = [16, 32, 64, 128, 256, 512]
  for (const size of sizes) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(iconsetDir, `icon_${size}x${size}.png`))

    await sharp(svgBuffer)
      .resize(size * 2, size * 2)
      .png()
      .toFile(path.join(iconsetDir, `icon_${size}x${size}@2x.png`))
  }

  execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`)
  fs.rmSync(iconsetDir, { recursive: true })

  // PNG 1024×1024 dédié pour app.dock.setIcon()
  // macOS rend les icônes dock en @2x (Retina) → la source doit être 1024px
  // pour éviter l'upscaling et garantir un rendu net sur tous les écrans.
  await sharp(svgBuffer)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(root, 'build', 'icon-dock.png'))

  console.log('✓ Icône générée : build/icon.icns + build/icon-dock.png (1024×1024)')
}

main().catch(err => {
  console.error('❌ Erreur génération icône :', err.message)
  process.exit(1)
})
