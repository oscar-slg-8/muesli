import type { Meeting, TranscriptSegment } from '../types'
import { request } from 'node:https'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  return m > 0 ? `${m}min` : '< 1min'
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function exportToMarkdown(meeting: Meeting, _segments: TranscriptSegment[]): string {
  const title = meeting.title || 'Réunion sans titre'
  const date = new Date(meeting.createdAt).toISOString()
  const duration = formatDuration(meeting.durationSeconds)
  const attendees =
    meeting.attendees && meeting.attendees.length > 0 ? `[${meeting.attendees.join(', ')}]` : '[]'

  const frontmatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: ${date}`,
    `duration: ${duration}`,
    `attendees: ${attendees}`,
    `tags: [meeting]`,
    '---',
    ''
  ].join('\n')

  return frontmatter + (meeting.summaryMarkdown || '')
}

interface NotionTextContent {
  type: 'text'
  text: { content: string }
}

interface NotionRichTextBlock {
  object: 'block'
  type: 'paragraph' | 'heading_2' | 'heading_3'
  paragraph?: { rich_text: NotionTextContent[] }
  heading_2?: { rich_text: NotionTextContent[] }
  heading_3?: { rich_text: NotionTextContent[] }
}

interface NotionToggleBlock {
  object: 'block'
  type: 'toggle'
  toggle: {
    rich_text: NotionTextContent[]
    children: NotionRichTextBlock[]
  }
}

type NotionBlock = NotionRichTextBlock | NotionToggleBlock

function richText(content: string): NotionTextContent[] {
  const MAX = 2000
  return [{ type: 'text', text: { content: content.slice(0, MAX) } }]
}

function paragraph(text: string): NotionRichTextBlock {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(text) } }
}

function heading2(text: string): NotionRichTextBlock {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: richText(text) } }
}

function buildNotionBlocks(meeting: Meeting, segments: TranscriptSegment[]): NotionBlock[] {
  const blocks: NotionBlock[] = []
  const MAX_TOTAL = 95

  // Summary section
  blocks.push(heading2('Résumé'))
  const summaryLines = (meeting.summaryMarkdown || '').split('\n').filter(l => l.trim())
  for (const line of summaryLines) {
    if (blocks.length >= MAX_TOTAL - 10) break
    blocks.push(paragraph(line))
  }

  // Transcript toggle
  const transcriptChildren: NotionRichTextBlock[] = []
  const remaining = MAX_TOTAL - blocks.length - 1
  const segsToInclude = segments.slice(0, remaining)
  const truncated = segments.length > segsToInclude.length

  for (const seg of segsToInclude) {
    const speaker = seg.speaker === 'me' ? meeting.speakerMe : meeting.speakerOthers
    transcriptChildren.push(
      paragraph(`${speaker} (${formatTimestamp(seg.startTime)}) — ${seg.text}`)
    )
  }
  if (truncated) {
    transcriptChildren.push(
      paragraph(
        `... (${segments.length - segsToInclude.length} segments supplémentaires non inclus)`
      )
    )
  }

  blocks.push({
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: richText(`Transcription (${segments.length} segments)`),
      children: transcriptChildren
    }
  })

  return blocks
}

function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }
    const req = request(options, res => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export async function exportToNotion(
  meeting: Meeting,
  segments: TranscriptSegment[],
  token: string,
  databaseId: string
): Promise<string> {
  const title = meeting.title || 'Réunion sans titre'
  const children = buildNotionBlocks(meeting, segments)

  const payload = JSON.stringify({
    parent: { database_id: databaseId },
    properties: {
      Name: { title: [{ type: 'text', text: { content: title } }] }
    },
    children
  })

  const response = await httpsPost('https://api.notion.com/v1/pages', payload, {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28'
  })

  if (response.status < 200 || response.status >= 300) {
    let msg = `Erreur Notion HTTP ${response.status}`
    try {
      const parsed = JSON.parse(response.body) as { message?: string }
      if (parsed.message?.includes('is a page, not a database')) {
        throw new Error(
          "L'ID configuré est celui d'une page Notion, pas d'une base. " +
            "Ouvre ta base en pleine page dans Notion (↗), puis copie l'ID depuis l'URL."
        )
      }
      if (parsed.message) msg = `Erreur Notion : ${parsed.message}`
    } catch (inner) {
      if (inner instanceof Error && inner.message.startsWith("L'ID")) throw inner
    }
    throw new Error(msg)
  }

  const parsed = JSON.parse(response.body) as { id?: string }
  const pageId = parsed.id?.replace(/-/g, '') ?? ''
  return `https://notion.so/${pageId}`
}
