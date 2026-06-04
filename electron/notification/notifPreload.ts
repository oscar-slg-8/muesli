// ============================================================
// Preload de la fenêtre de notification de réunion.
// Expose une mini-API au document HTML de la carte (boutons).
// ============================================================

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('muesliNotif', {
  join: (): void => ipcRenderer.send('notif:join'),
  dismiss: (): void => ipcRenderer.send('notif:dismiss')
})
