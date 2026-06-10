// scripts/sign-selfsigned.js
// Hook afterPack electron-builder : signe l'app avec un certificat auto-signé
// LOCAL (gratuit, sans compte Apple) pour lui donner une identité de code STABLE.
//
// Pourquoi : macOS rattache les permissions TCC (Micro) à la signature de l'app.
// Une signature ad-hoc change à chaque build → la permission Micro est perdue à
// chaque mise à jour (et l'icône/cache se désynchronise). En resignant chaque
// build avec LE MÊME certificat auto-signé, l'identité reste stable → la
// permission persiste entre les maj.
//
// Ce certificat ne notarise PAS : au 1er lancement, macOS affichera « développeur
// non identifié » → clic droit sur Muesli → Ouvrir (une seule fois).
//
// Création du trousseau + cert (une fois) :
//   voir scripts/setup-selfsigned-cert.sh
//
// Si le trousseau/cert est absent (ex. CI, autre machine), on saute proprement :
// l'app reste ad-hoc, exactement comme avant.

const { execFileSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

const IDENTITY = 'Muesli Self Signed'
const KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'muesli-signing.keychain-db')
const KEYCHAIN_PASSWORD = 'muesli'

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  if (!fs.existsSync(KEYCHAIN)) {
    console.log(
      `[sign-selfsigned] Trousseau ${KEYCHAIN} absent — signature auto-signée sautée (app ad-hoc).`
    )
    return
  }

  try {
    const ids = execFileSync('security', ['find-identity', '-p', 'codesigning', KEYCHAIN], {
      encoding: 'utf8'
    })
    if (!ids.includes(IDENTITY)) {
      console.log(`[sign-selfsigned] Identité « ${IDENTITY} » introuvable — signature sautée.`)
      return
    }
  } catch {
    console.log('[sign-selfsigned] find-identity a échoué — signature sautée.')
    return
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!fs.existsSync(appPath)) {
    console.warn(`[sign-selfsigned] App introuvable : ${appPath}`)
    return
  }

  execFileSync('security', ['unlock-keychain', '-p', KEYCHAIN_PASSWORD, KEYCHAIN])

  // Signer D'ABORD les helpers embarqués dans Resources/ : codesign --deep sur
  // l'app principale ne descend PAS dans Contents/Resources. Une identité STABLE
  // y est indispensable pour que leurs permissions TCC (ex. Calendrier pour
  // CalendarHelper.app) persistent entre les mises à jour.
  const resources = path.join(appPath, 'Contents', 'Resources')
  const nestedHelpers = [
    path.join(resources, 'CalendarHelper.app'),
    path.join(resources, 'system-audio-capture')
  ]
  for (const target of nestedHelpers) {
    if (fs.existsSync(target)) {
      execFileSync(
        'codesign',
        ['--force', '--deep', '--sign', IDENTITY, '--keychain', KEYCHAIN, target],
        { stdio: 'inherit' }
      )
      console.log(`[sign-selfsigned] helper signé : ${path.basename(target)}`)
    }
  }

  // Puis l'app principale (scelle le bundle, helpers signés inclus).
  // Pas de hardened runtime (non notarisé) : évite de casser les helpers.
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', IDENTITY, '--keychain', KEYCHAIN, appPath],
    { stdio: 'inherit' }
  )
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' })
  console.log(`[sign-selfsigned] ${path.basename(appPath)} signé « ${IDENTITY} » ✓`)
}
