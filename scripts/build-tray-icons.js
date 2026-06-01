// ============================================================
// Génère les icônes Tray (menu bar) macOS :
//   build/trayTemplate.png    — 18×18 px (1x)
//   build/trayTemplate@2x.png — 36×36 px (2x Retina)
//
// Template image macOS = NOIR sur TRANSPARENT uniquement.
// macOS colore automatiquement selon le thème.
//
// Approche : on réutilise la même forme que icon.svg (le chunk de
// muesli) mais remplie en noir, dans un viewBox qui la cadre avec
// ~10% de marge pour la lisibilité en 18px.
// ============================================================

const sharp = require('sharp')
const path = require('path')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'build')

// Silhouette du chunk de muesli — même path que icon.svg
// Le path original vit dans un espace ~168..350 × 170..336 (182×166 px).
// On utilise un viewBox serré avec un peu de marge pour le cadrer.
const traySvg = `<svg width="36" height="36" viewBox="150 150 210 200" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="
    M196 196
    C204 178, 232 168, 264 170
    C296 172, 324 180, 336 198
    C348 216, 350 240, 344 264
    C338 288, 326 308, 304 320
    C282 332, 248 336, 220 328
    C192 316, 172 292, 168 264
    C164 236, 180 214, 196 196
    Z
  " fill="#000000"/>
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
