// ============================================================
// SettingsManager — chiffrement Keychain + lecture/écriture settings
// ============================================================

import { safeStorage } from 'electron'
import { DatabaseService } from '../../src/services/database'
import { DEFAULT_SETTINGS } from '../../src/types'
import type { Settings } from '../../src/types'

// Les clés API sont chiffrées avec safeStorage (macOS Keychain) avant
// d'être stockées dans SQLite. Cela empêche un simple `cp muesli.db`
// de voler les clés. Le déchiffrement n'est possible que par l'app
// signée sur la machine de l'utilisateur.
export const SENSITIVE_KEYS = new Set([
  'apiKeyGroq',
  'apiKeyAnthropic',
  'apiKeyMistral',
  'apiKeyPyannote',
  'apiKeyNotion'
])
export const ENCRYPTED_PREFIX = 'enc::'

export class SettingsManager {
  private database: DatabaseService

  constructor(database: DatabaseService) {
    this.database = database
  }

  encryptSensitive(value: string): string {
    if (!value) return value
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Keychain macOS indisponible — stockage des clés API refusé')
    }
    const encrypted = safeStorage.encryptString(value)
    return ENCRYPTED_PREFIX + encrypted.toString('base64')
  }

  decryptSensitive(stored: string): string {
    if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored // legacy plaintext
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[settings] safeStorage unavailable, cannot decrypt')
      return ''
    }
    try {
      const buf = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      console.warn('[settings] safeStorage decryption failed')
      return ''
    }
  }

  getSettings(): Settings {
    const s = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(s) as Array<keyof Settings>) {
      const raw = this.database.getSetting(key, '')
      if (raw !== '') {
        const val = SENSITIVE_KEYS.has(key) ? this.decryptSensitive(raw) : raw
        if (typeof s[key] === 'boolean') {
          ;(s as Record<string, unknown>)[key] = val === 'true'
        } else {
          ;(s as Record<string, unknown>)[key] = val
        }
      }
    }
    return s
  }

  saveSetting(key: string, value: string): void {
    const stored = SENSITIVE_KEYS.has(key) ? this.encryptSensitive(value) : value
    this.database.setSetting(key, stored)
  }

  /** One-time migration: encrypt plaintext API keys already in the DB */
  migrateToEncrypted(): void {
    // N'accéder au Keychain (safeStorage) QUE s'il y a vraiment des clés en clair
    // à chiffrer. Sinon, `isEncryptionAvailable()` déclenche un prompt Keychain
    // (« entrez le mot de passe du trousseau ») à CHAQUE démarrage, alors même
    // qu'aucune clé API n'est configurée. La détection se fait sur la DB (pas de
    // Keychain), donc aucun prompt tant qu'il n'y a rien à migrer.
    const plaintextKeys = [...SENSITIVE_KEYS].filter(key => {
      const raw = this.database.getSetting(key, '')
      return raw !== '' && !raw.startsWith(ENCRYPTED_PREFIX)
    })
    if (plaintextKeys.length === 0) return

    if (!safeStorage.isEncryptionAvailable()) return
    for (const key of plaintextKeys) {
      const raw = this.database.getSetting(key, '')
      const encrypted = this.encryptSensitive(raw)
      if (encrypted !== raw) {
        this.database.setSetting(key, encrypted)
        console.log(`[settings] Clé ${key} migrée vers le stockage chiffré`)
      }
    }
  }
}
