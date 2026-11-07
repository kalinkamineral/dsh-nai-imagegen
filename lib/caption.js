/**
 * dsh-nai-imagegen — a structured caption from the workbench.
 *
 * The workbench edits a prompt as a scene caption plus up to six characters,
 * each with its own positive, negative and position. `<image>` blocks and comic
 * pages arrive as text and are parsed by lib/format.js and lib/comic.js; this
 * one arrives already structured, and is turned into the same page shape so the
 * render path (artist string, UC preset, header, per-character captions) treats
 * all three alike.
 */

/** NovelAI V4+ accepts at most six character captions. */
export const MAX_CHARACTERS = 6

/** A 5×5 grid cell, A1 top-left … E5 bottom-right. */
const CELL = /^[A-E][1-5]$/i

/**
 * One character's position.
 * @param value - `'C3'`, `{ x, y }` in 0..1, or nothing.
 * @returns a centers list for lib/nai.js (`['C3']` or `[{x,y}]`), possibly empty.
 */
function centersOf(value) {
  if (typeof value === 'string' && CELL.test(value.trim())) return [value.trim().toUpperCase()]
  if (value !== null && typeof value === 'object') {
    const x = Number(value.x)
    const y = Number(value.y)
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }]
    }
  }
  return []
}

/**
 * Turn a workbench caption into the render path's page shape.
 *
 * @param caption - `{ base, baseNegative?, characters: [{ name?, positive, negative?, center? }] }`.
 * @returns the page, or `null` when the caption is absent or has nothing to draw.
 */
export function captionPage(caption) {
  if (caption === null || typeof caption !== 'object' || Array.isArray(caption)) return null
  const base = String(caption.base ?? '').trim()
  const baseNegative = String(caption.baseNegative ?? '').trim()
  const rows = Array.isArray(caption.characters) ? caption.characters : []
  const characters = rows
    .slice(0, MAX_CHARACTERS)
    .map((row, index) => ({
      label: String(row?.name ?? '').trim() || `Char${index + 1}`,
      index: index + 1,
      text: String(row?.positive ?? '').trim(),
      negative: String(row?.negative ?? '').trim(),
      centers: centersOf(row?.center)
    }))
    .filter((row) => row.text !== '')
  if (base === '' && characters.length === 0) return null
  const notes = []
  if (rows.length > MAX_CHARACTERS) notes.push(`角色超过 ${MAX_CHARACTERS} 个，多出的没有发送`)
  return {
    ok: true,
    format: 'caption',
    prompt: [base, ...characters.map((row) => row.text)].filter((text) => text !== '').join(', '),
    negativePrompt: [...characters.map((row) => row.negative).filter((text) => text !== ''), baseNegative]
      .filter((text) => text !== '')
      .join(', '),
    sceneCaption: base,
    sceneNegative: baseNegative,
    characters,
    notes,
    sizeSource: null
  }
}
