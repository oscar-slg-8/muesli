// ============================================================
// Génère les icônes Tray (menu bar) macOS :
//   build/trayTemplate.png    — 18×18 px (1x)
//   build/trayTemplate@2x.png — 36×36 px (2x Retina)
//
// Template image macOS = NOIR sur TRANSPARENT uniquement.
// macOS colore automatiquement selon le thème (noir sur barre claire,
// blanc sur barre sombre).
//
// Forme : même identité que icon.svg — bol & flocons (silhouette pleine),
// tracée dans un viewBox serré 36×36 pour rester lisible en 18px.
// ============================================================

const sharp = require('sharp')
const path = require('path')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'build')

const traySvg = `<svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="18" cy="17.3" rx="14" ry="3" fill="#000000"/>
  <path d="M4 17.3 A14 14 0 0 0 32 17.3 Z" fill="#000000"/>
  <circle cx="12.35" cy="10.05" r="2.7" fill="#000000"/>
  <circle cx="19.6" cy="8.15" r="3.5" fill="#000000"/>
  <circle cx="25.25" cy="11.1" r="2.3" fill="#000000"/>
</svg>`

async function main() {
  // 1x — 18×18
  await sharp(Buffer.from(traySvg))
    .resize(18, 18)
    .png()
    .toFile(path.join(outDir, 'trayTemplate.png'))

  // 2x — 36×36
  await sharp(Buffer.from(traySvg))
    .resize(36, 36)
    .png()
    .toFile(path.join(outDir, 'trayTemplate@2x.png'))

  console.log('✓ Tray icons générées : trayTemplate.png (18px) + trayTemplate@2x.png (36px)')
}

main().catch(err => {
  console.error('❌ Erreur génération tray icons :', err.message)
  process.exit(1)
})
