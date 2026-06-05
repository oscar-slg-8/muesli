// ============================================================
// Menu barre de menu macOS (Tray)
// Icône discrète avec menu contextuel, raccourci clavier global,
// et événements du calendrier.
// ============================================================

import { Tray, Menu, nativeImage, globalShortcut, app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { getUpcomingMeetings, type CalendarEvent } from './calendar'

let tray: Tray | null = null
let isRecording = false
let refreshTimer: ReturnType<typeof setInterval> | null = null
let registeredShortcut: string | null = null

export interface TrayCallbacks {
  onStartRecording: (title?: string) => void
  onStopRecording: () => void
  onOpenWindow: () => void
  onQuit: () => void
  onTestNotification?: () => void
}

// Construit un menu de base de manière synchrone (sans attendre le calendrier).
function buildBasicMenu(callbacks: TrayCallbacks): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: isRecording ? '⏹ Arrêter et transcrire' : "⏺ Démarrer l'enregistrement",
      click: isRecording ? callbacks.onStopRecording : () => callbacks.onStartRecording()
    },
    { type: 'separator' },
    { label: 'Ouvrir Muesli', click: callbacks.onOpenWindow },
    { type: 'separator' },
    { label: 'Quitter', click: callbacks.onQuit }
  ])
}

export function createTray(callbacks: TrayCallbacks, shortcut: string): Tray {
  // Icône tray macOS — "template image" :
  //   - Le PNG doit être NOIR sur TRANSPARENT (pas de couleur, pas de fond).
  //   - macOS colore automatiquement : blanc sur barre sombre, noir sur barre claire.
  //   - setTemplateImage(true) est OBLIGATOIRE même si le nom contient "Template" —
  //     Electron ne le détecte pas toujours automatiquement.
  //   - Pas de resize() : les assets sont déjà à 18px (1x) et 36px (2x).
  // Résolution robuste dev + packagé :
  //  - dev : <projet>/build/trayTemplate.png  (app.getAppPath() = racine projet)
  //  - packagé : process.resourcesPath/trayTemplate.png (via extraResources),
  //    car build/ n'est PAS inclus dans app.asar.
  const trayCandidates = [
    join(app.getAppPath(), 'build', 'trayTemplate.png'),
    join(process.resourcesPath, 'trayTemplate.png')
  ]
  const trayIconPath = trayCandidates.find(p => existsSync(p))
  let trayIcon: Electron.NativeImage

  if (trayIconPath) {
    trayIcon = nativeImage.createFromPath(trayIconPath)
    console.log(
      `[tray] Icône chargée : ${trayIconPath} (empty=${trayIcon.isEmpty()}, ` +
        `size=${JSON.stringify(trayIcon.getSize())})`
    )
  } else {
    console.error(
      '[tray] Aucune icône tray trouvée — le Tray sera invisible. Cherché :',
      trayCandidates
    )
    trayIcon = nativeImage.createEmpty()
  }
  trayIcon.setTemplateImage(true)

  tray = new Tray(trayIcon)
  tray.setToolTip('Muesli')

  tray.setContextMenu(buildBasicMenu(callbacks))
  refreshTrayMenu(callbacks)

  tray.on('click', callbacks.onOpenWindow)

  const registered = globalShortcut.register(shortcut, () => {
    if (isRecording) {
      callbacks.onStopRecording()
    } else {
      callbacks.onStartRecording()
    }
  })
  if (!registered) {
    console.error(
      `[tray] ⚠️ Raccourci "${shortcut}" non enregistré — conflit avec une autre application`
    )
  } else {
    registeredShortcut = shortcut
    console.log(`[tray] Raccourci global enregistré : ${shortcut}`)
  }

  refreshTimer = setInterval(() => refreshTrayMenu(callbacks), 5 * 60 * 1000)

  return tray
}

export function setRecordingState(recording: boolean, callbacks: TrayCallbacks): void {
  isRecording = recording
  if (tray) {
    tray.setTitle(recording ? ' ● REC' : '')
  }
  refreshTrayMenu(callbacks)
}

async function refreshTrayMenu(callbacks: TrayCallbacks): Promise<void> {
  if (!tray) return

  let events: CalendarEvent[] = []
  try {
    events = await getUpcomingMeetings()
  } catch (err) {
    console.warn('[tray] Erreur chargement calendrier :', err)
  }

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: isRecording ? '⏹ Arrêter et transcrire' : "⏺ Démarrer l'enregistrement",
      click: isRecording ? callbacks.onStopRecording : () => callbacks.onStartRecording()
    },
    { type: 'separator' }
  ]

  if (events.length > 0) {
    menuItems.push({ label: 'Prochains meetings', enabled: false })

    for (const event of events.slice(0, 8)) {
      const start = new Date(event.startDate)
      const timeStr = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      const now = new Date()
      const isNow = new Date(event.startDate) <= now && new Date(event.endDate) > now
      const prefix = isNow ? '● ' : '  '
      const label = `${prefix}${timeStr} – ${event.title}`

      menuItems.push({
        label,
        enabled: !isRecording,
        click: () => callbacks.onStartRecording(event.title)
      })
    }

    menuItems.push({ type: 'separator' })
  }

  menuItems.push({ label: 'Ouvrir Muesli', click: callbacks.onOpenWindow })

  // Test manuel de la notification (dev uniquement).
  // NB : on ne peut PAS se fier à app.isPackaged ici — patch-electron renomme
  // le binaire en « Muesli », ce qui force app.isPackaged à true même en dev.
  // Le signal fiable est ELECTRON_RENDERER_URL, injecté par electron-vite en dev.
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
  if (isDev && callbacks.onTestNotification) {
    menuItems.push({ label: '🔔 Tester la notification', click: callbacks.onTestNotification })
  }

  menuItems.push({ type: 'separator' }, { label: 'Quitter', click: callbacks.onQuit })

  const menu = Menu.buildFromTemplate(menuItems)
  tray.setContextMenu(menu)
}

export function destroyTray(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (registeredShortcut) {
    try {
      globalShortcut.unregister(registeredShortcut)
    } catch {
      /* ignore */
    }
    registeredShortcut = null
  }
  tray?.destroy()
  tray = null
}
