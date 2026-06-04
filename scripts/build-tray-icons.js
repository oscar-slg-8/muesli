// ============================================================
// Génère les icônes Tray (menu bar) macOS :
//   build/trayTemplate.png    — 18×18 px (1x)
//   build/trayTemplate@2x.png — 36×36 px (2x Retina)
//
// Template image macOS = NOIR sur TRANSPARENT uniquement.
// macOS colore automatiquement selon le thème (noir sur barre claire,
// blanc sur barre sombre).
//
// Forme : même identité que icon.svg — octogone (contour) + bol & flocons,
// mais tracée dans un viewBox serré 36×36 avec des épaisseurs adaptées
// à la lisibilité en 18px.
// ============================================================

const sharp = require('sharp')
const path = require('path')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'build')

// Octogone régulier centré (18,18) rayon 15 — sommet plat haut/bas.
function octagonPath(cx, cy, R) {
  const pts = []
  for (let k = 0; k < 8; k++) {
    const a = ((22.5 + 45 * k) * Math.PI) / 180
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)])
  }
  return (
    pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ') +
    ' Z'
  )
}

const oct = octagonPath(18, 18, 15)

const traySvg = `<svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="${oct}" fill="none" stroke="#000000" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M12.6 19.4 A5.4 5.4 0 0 0 23.4 19.4 Z" fill="#000000"/>
  <ellipse cx="18" cy="19.4" rx="5.4" ry="1.15" fill="#000000"/>
  <circle cx="15.8" cy="16.6" r="1.05" fill="#000000"/>
  <circle cx="18.6" cy="15.9" r="1.35" fill="#000000"/>
  <circle cx="20.8" cy="17.0" r="0.9" fill="#000000"/>
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
