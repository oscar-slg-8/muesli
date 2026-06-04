// ============================================================
// Notification de réunion — fenêtre custom style « Granola ».
// Une carte flottante (BrowserWindow sans cadre, transparente) en haut
// à droite de l'écran principal, avec un bouton « Rejoindre & enregistrer ».
//
// UNE seule notification par réunion (gérée côté main via un Set).
// Auto-dismiss après AUTO_DISMISS_MS.
// ============================================================

import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'

const AUTO_DISMISS_MS = 45_000
const CARD_WIDTH = 400
const CARD_HEIGHT = 104
const MARGIN = 16

export interface NotificationCallbacks {
  onJoin: () => void
  onDismiss?: () => void
}

interface ActiveNotif {
  win: BrowserWindow
  callbacks: NotificationCallbacks
  autoTimer: ReturnType<typeof setTimeout> | null
}

let active: ActiveNotif | null = null
let ipcWired = false

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTimeRange(startIso: string, endIso?: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  const start = new Date(startIso).toLocaleTimeString('fr-FR', opts)
  if (!endIso) return start
  const end = new Date(endIso).toLocaleTimeString('fr-FR', opts)
  return `${start} – ${end}`
}

function buildHtml(title: string, timeRange: string, hasUrl: boolean): string {
  const safeTitle = escapeHtml(title)
  const buttonLabel = hasUrl ? 'Rejoindre &amp; enregistrer' : 'Enregistrer'

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
    -webkit-user-select: none;
    user-select: none;
    overflow: hidden;
  }
  .card {
    position: relative;
    margin: 8px;
    height: ${CARD_HEIGHT - 16}px;
    background: #FFFFFF;
    border-radius: 16px;
    border: 1px solid rgba(0,0,0,0.06);
    box-shadow: 0 8px 28px rgba(0,0,0,0.18);
    display: flex;
    align-items: center;
    padding: 12px 14px;
    gap: 12px;
    -webkit-app-region: no-drag;
  }
  .accent {
    width: 4px;
    align-self: stretch;
    border-radius: 4px;
    background: #2563EB;
    flex: 0 0 auto;
  }
  .info { flex: 1 1 auto; min-width: 0; }
  .title {
    font-size: 14px;
    font-weight: 600;
    color: #0A0A0A;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .time {
    margin-top: 3px;
    font-size: 12px;
    color: #6B7280;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .brand {
    font-weight: 600;
    color: #2563EB;
  }
  .join {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: #2563EB;
    color: #fff;
    border: none;
    border-radius: 10px;
    padding: 9px 13px;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .join:hover { background: #1D4ED8; }
  .join:active { background: #1E40AF; }
  .rec {
    width: 8px; height: 8px; border-radius: 50%;
    background: #EF4444;
    box-shadow: 0 0 0 0 rgba(239,68,68,0.6);
    animation: pulse 1.6s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); }
    70% { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
    100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
  }
  .close {
    position: absolute;
    top: -6px; left: -6px;
    width: 20px; height: 20px;
    border-radius: 50%;
    background: #6B7280;
    color: #fff;
    border: 2px solid #fff;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 6px rgba(0,0,0,0.2);
  }
  .close:hover { background: #4B5563; }
</style>
</head>
<body>
  <div class="card">
    <button class="close" id="close" title="Ignorer">×</button>
    <div class="accent"></div>
    <div class="info">
      <div class="title">${safeTitle}</div>
      <div class="time">${escapeHtml(timeRange)} · <span class="brand">Muesli</span></div>
    </div>
    <button class="join" id="join">
      <span class="rec"></span>${buttonLabel}
    </button>
  </div>
  <script>
    document.getElementById('join').addEventListener('click', () => window.muesliNotif.join());
    document.getElementById('close').addEventListener('click', () => window.muesliNotif.dismiss());
  </script>
</body>
</html>`
}

function wireIpcOnce(): void {
  if (ipcWired) return
  ipcWired = true

  ipcMain.on('notif:join', () => {
    const cb = active?.callbacks
    closeNotification()
    cb?.onJoin()
  })

  ipcMain.on('notif:dismiss', () => {
    const cb = active?.callbacks
    closeNotification()
    cb?.onDismiss?.()
  })
}

export function closeNotification(): void {
  if (!active) return
  if (active.autoTimer) clearTimeout(active.autoTimer)
  if (!active.win.isDestroyed()) active.win.close()
  active = null
}

export interface MeetingNotificationData {
  title: string
  startDate: string
  endDate?: string
  hasUrl: boolean
}

export function showMeetingNotification(
  data: MeetingNotificationData,
  callbacks: NotificationCallbacks
): void {
  wireIpcOnce()

  // Une seule notification à la fois : on remplace l'éventuelle précédente.
  closeNotification()

  const display = screen.getPrimaryDisplay()
  const { width: sw, x: sx, y: sy } = display.workArea
  const x = sx + sw - CARD_WIDTH - MARGIN
  const y = sy + MARGIN

  const win = new BrowserWindow({
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/notif.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Visible au-dessus de tout, y compris en plein écran (visio).
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const html = buildHtml(data.title, formatTimeRange(data.startDate, data.endDate), data.hasUrl)
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (active?.win === win) {
      if (active.autoTimer) clearTimeout(active.autoTimer)
      active = null
    }
  })

  const autoTimer = setTimeout(() => {
    closeNotification()
    callbacks.onDismiss?.()
  }, AUTO_DISMISS_MS)

  active = { win, callbacks, autoTimer }
}
