// ============================================================
// IPC Input Validation — zod schemas + safeHandle wrapper
//
// Toutes les données venant du renderer sont non-fiables.
// safeHandle() valide le payload avant d'appeler le handler.
// Échec de validation → Error loggée + exception vers le renderer.
// ============================================================

import { z } from 'zod'
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

// ── Primitives réutilisables ──────────────────────────────────────────────────
const uuid = z.string().uuid()
const idNum = z.number().int().positive()
const shortStr = z.string().max(255)
const longStr = z.string().max(500_000)

// ── Schemas par channel ───────────────────────────────────────────────────────
export const IpcSchemas = {
  // meetings — lecture
  'meetings:get': uuid,
  'meetings:getSegments': uuid,
  'meetings:delete': uuid,
  'meetings:search': z.string().max(1_000),
  'meetings:getSpeakerNames': uuid,
  'meetings:getAudioInfo': uuid,

  // meetings — écriture (multi-args → tuple)
  'meetings:updateNotes': z.tuple([uuid, longStr]),
  'meetings:updateTitle': z.tuple([uuid, shortStr]),
  'meetings:updateLanguage': z.tuple([uuid, z.enum(['fr', 'en'])]),
  'meetings:setSpeakerName': z.tuple([uuid, z.string().max(100), z.string().max(100)]),
  'meetings:updateSegment': z.tuple([idNum, z.string().max(50_000)]),

  // recording
  'recording:startFromDraft': uuid,

  // transcription / résumé
  'transcription:retry': uuid,
  'summarization:retry': z.tuple([uuid, idNum.optional()]),

  // templates
  'templates:create': z.tuple([shortStr, z.string().max(100_000)]),
  'templates:update': z.tuple([idNum, shortStr, z.string().max(100_000)]),
  'templates:delete': idNum,

  // settings
  'settings:update': z.record(z.string().max(100), z.unknown()),

  // export
  'export:saveFile': z.tuple([shortStr, z.string().max(10_000_000)]),
  'export:copyToClipboard': z.string().max(1_000_000),
  'export:notion': uuid,
  'export:notionBulk': z.array(uuid).min(1).max(100),

  // system
  'system:openExternal': z
    .string()
    .max(2_048)
    .refine(url => /^https?:\/\//.test(url), { message: 'URL must start with http:// or https://' })
} as const

// ── Wrapper universel ─────────────────────────────────────────────────────────
export function safeHandle<T>(
  channel: string,
  schema: z.ZodType<T>,
  handler: (data: T, event: IpcMainInvokeEvent) => Promise<unknown> | unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    // Single-arg handlers: validate args[0] directly.
    // Multi-arg handlers: validate the args array as a tuple.
    const raw = args.length === 1 ? args[0] : args
    const result = schema.safeParse(raw)
    if (!result.success) {
      console.error(`[ipc] Validation failed on '${channel}':`, result.error.issues)
      throw new Error(`IPC validation failed: ${channel}`)
    }
    return handler(result.data, event)
  })
}
