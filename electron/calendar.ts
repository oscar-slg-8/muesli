// ============================================================
// Service calendrier — Lit les événements du jour via EventKit (binaire Swift)
// Cache de 5 minutes pour éviter de spawner le binaire trop souvent.
// ============================================================

import { execFile } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'

export interface CalendarEvent {
  id: string // EventKit eventIdentifier
  title: string
  startDate: string // ISO 8601
  endDate: string
  isAllDay: boolean
  isMeeting: boolean
  calendarName: string
  location?: string
  url?: string
  notes?: string
  attendees?: string[] // Participant display names
}

let cachedEvents: CalendarEvent[] = []
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function getHelperPath(): string {
  // Le helper est désormais empaqueté dans un .app afin de porter un Info.plist
  // (descriptions d'usage Calendrier). Sans ça, EventKit refuse l'accès sur
  // macOS 14+. On exécute le binaire interne ; Bundle.main résout vers le .app
  // et EventKit y lit NSCalendarsFullAccessUsageDescription.
  const bundleRel = join('CalendarHelper.app', 'Contents', 'MacOS', 'calendar-helper')

  // En dev : resources/CalendarHelper.app (racine du projet)
  const devBundle = join(app.getAppPath(), 'resources', bundleRel)
  if (existsSync(devBundle)) return devBundle

  // En prod : process.resourcesPath/CalendarHelper.app
  const prodBundle = join(process.resourcesPath, bundleRel)
  if (existsSync(prodBundle)) return prodBundle

  // Fallback legacy : binaire nu (anciens packages)
  const devLegacy = join(app.getAppPath(), 'resources', 'calendar-helper')
  if (existsSync(devLegacy)) return devLegacy
  const prodLegacy = join(process.resourcesPath, 'calendar-helper')
  if (existsSync(prodLegacy)) return prodLegacy

  return devBundle // Fallback — laissera une erreur claire
}

export async function getCalendarEvents(forceRefresh = false): Promise<CalendarEvent[]> {
  const now = Date.now()
  if (!forceRefresh && cachedEvents.length > 0 && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEvents
  }

  const helperPath = getHelperPath()
  if (!existsSync(helperPath)) {
    console.warn('[calendar] Binaire calendar-helper introuvable :', helperPath)
    return []
  }

  return new Promise(resolve => {
    execFile(helperPath, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[calendar] Erreur exécution calendar-helper :', err.message)
        if (stderr) console.error('[calendar] stderr :', stderr)
        resolve(cachedEvents) // Retourner le cache périmé plutôt que rien
        return
      }

      try {
        const parsed = JSON.parse(stdout)
        if (parsed.error) {
          console.warn('[calendar] EventKit :', parsed.error)
        }
        cachedEvents = (parsed.events || []) as CalendarEvent[]
        cacheTimestamp = Date.now()
        resolve(cachedEvents)
      } catch (parseErr) {
        console.error('[calendar] JSON invalide :', parseErr)
        resolve([])
      }
    })
  })
}

// ============================================================
// Extraction d'URL de réunion depuis les champs d'une invitation
// ============================================================

// Patterns regex couvrant les principales plateformes de visio.
// Ordre : du plus spécifique au plus générique pour éviter les faux positifs.
const MEETING_URL_PATTERNS: RegExp[] = [
  // Zoom : https://zoom.us/j/123456789 ou https://company.zoom.us/j/123?pwd=abc
  /https?:\/\/[a-z0-9-]*\.?zoom\.us\/j\/[^\s"<>[\]]+/gi,
  // Google Meet : https://meet.google.com/abc-defg-hij
  /https?:\/\/meet\.google\.com\/[a-z0-9-]+/gi,
  // Microsoft Teams (lien de réunion standard)
  /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>[\]]+/gi,
  // Microsoft Teams Live
  /https?:\/\/teams\.live\.com\/meet\/[^\s"<>[\]]+/gi,
  // Webex
  /https?:\/\/[a-z0-9-]*\.webex\.com\/[a-z0-9-]+\/j\.php[^\s"<>[\]]*/gi,
  // Whereby
  /https?:\/\/[a-z0-9-]*\.?whereby\.com\/[^\s"<>[\]]+/gi,
  // Jitsi Meet
  /https?:\/\/meet\.jit\.si\/[^\s"<>[\]]+/gi,
  // Skype
  /https?:\/\/join\.skype\.com\/[^\s"<>[\]]+/gi,
  // GoTo Meeting
  /https?:\/\/(?:[a-z0-9-]*\.)?goto(?:meeting)?\.com\/[^\s"<>[\]]+/gi,
  /https?:\/\/[a-z0-9-]*\.gotomeet\.me\/[^\s"<>[\]]+/gi,
  // BlueJeans
  /https?:\/\/[a-z0-9-]*\.?bluejeans\.com\/[^\s"<>[\]]+/gi,
  // 8x8
  /https?:\/\/[a-z0-9-]*\.?8x8\.vc\/[^\s"<>[\]]+/gi,
  // Around
  /https?:\/\/meet\.around\.co\/[^\s"<>[\]]+/gi,
  // Google Meet via lien court (g.co/meet)
  /https?:\/\/g\.co\/meet\/[^\s"<>[\]]+/gi
]

/**
 * Extrait le premier lien de réunion trouvé dans les champs d'un événement calendar.
 * Inspecte dans l'ordre : url → location → notes.
 * Retourne null si aucun lien reconnu n'est trouvé.
 */
export function extractMeetingUrl(event: CalendarEvent): string | null {
  const sources = [event.url, event.location, event.notes].filter(Boolean) as string[]

  for (const text of sources) {
    for (const pattern of MEETING_URL_PATTERNS) {
      pattern.lastIndex = 0 // Réinitialiser le curseur (flag /g en mode stateless)
      const match = pattern.exec(text)
      if (match) {
        // Nettoyer la ponctuation terminale qui peut être incluse par erreur
        return match[0].replace(/[,;)\].]$/, '')
      }
    }
  }

  return null
}

// ============================================================
// Détection d'un appel téléphonique / numéro composable
// ============================================================

// Mots-clés (FR/EN) signalant un point d'accès téléphonique dans l'invitation.
const PHONE_KEYWORDS = [
  'join by phone',
  'dial-in',
  'dial in',
  'phone number',
  'by phone',
  'call-in',
  'call in',
  'conference call',
  'one tap',
  'téléphone',
  'telephone',
  'appel téléphonique',
  'numéro de téléphone',
  'composez',
  'rejoindre par téléphone'
]

// Numéro composable : format international (+33 1 23 ...) ou français (01 23 45 67 89).
// Volontairement assez strict (>= 9 chiffres) pour limiter les faux positifs.
const PHONE_NUMBER_REGEX = /(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d(?:[\s.-]?\d{2}){4}\b)/

/**
 * Vrai si l'invitation mentionne un appel téléphonique ou contient un numéro
 * composable (mots-clés OU motif de numéro), dans url / location / notes.
 */
export function hasPhoneDialIn(event: CalendarEvent): boolean {
  const text = [event.url, event.location, event.notes].filter(Boolean).join('  ')
  if (!text) return false
  const lower = text.toLowerCase()
  if (PHONE_KEYWORDS.some(k => lower.includes(k))) return true
  return PHONE_NUMBER_REGEX.test(text)
}

/**
 * Un événement mérite-t-il une notification de réunion ?
 * Oui uniquement s'il a un lien visio (toute plateforme connue) OU un point
 * d'accès téléphonique. Filtre les events "sport", perso, etc.
 */
export function isJoinableMeeting(event: CalendarEvent): boolean {
  return Boolean(extractMeetingUrl(event)) || hasPhoneDialIn(event)
}

// Retourne uniquement les événements non all-day, futurs ou en cours
export async function getUpcomingMeetings(): Promise<CalendarEvent[]> {
  const events = await getCalendarEvents()
  const now = new Date()

  return events.filter(e => {
    if (e.isAllDay) return false
    const end = new Date(e.endDate)
    return end > now // Inclut les meetings en cours
  })
}

// Retourne les événements démarrant dans les N prochaines minutes (pas encore commencés)
export async function getUpcomingEvents(withinMinutes: number): Promise<CalendarEvent[]> {
  const events = await getCalendarEvents(true) // Force refresh pour avoir les données récentes
  const now = new Date()
  const cutoff = new Date(now.getTime() + withinMinutes * 60 * 1000)

  return events.filter(e => {
    if (e.isAllDay) return false
    const start = new Date(e.startDate)
    return start > now && start <= cutoff
  })
}
