/**
 * dsh-nai-imagegen — artist-string archive.
 *
 * The archive this reads is a 217 MB JSON array: 960 records, each carrying a
 * name, a sequence number, a positive and a negative prompt, and a
 * `referenceImage` data URL holding a base64 PNG. Roughly 226 KB per record,
 * almost all of it image.
 *
 * Two consequences shape everything below:
 *
 *   1. It must never be held in memory whole. `JSON.parse` on a 222M-character
 *      string costs about a gigabyte, which is not something a plugin inside the
 *      harness should do to its host.
 *   2. The images must not be duplicated onto disk either. 960 decodes would be
 *      ~150 MB of copies of data that already exists.
 *
 * So this module streams the file at the **byte** level, carving out one record
 * at a time by brace depth, parsing only that ~226 KB record, keeping the four
 * short fields, and recording the *byte range* of the base64 payload. Images are
 * then read back from the original file on demand.
 *
 * Scanning bytes rather than characters is deliberate and correct here: every
 * structural character this cares about is ASCII, and every UTF-8 continuation
 * byte is >= 0x80, so multibyte text cannot be mistaken for structure — and byte
 * offsets are exactly what `fs.read` wants afterwards.
 *
 * Zero external dependencies.
 */
import { open, readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** Read window; large enough that records rarely straddle more than two. */
const CHUNK_BYTES = 8 * 1024 * 1024
/** The data-URL prefix a reference image always carries. */
const DATA_URL_PREFIX = 'data:image/'
/** Marks the start of the base64 payload inside a data URL. */
const BASE64_MARKER = ';base64,'

/** Structural ASCII bytes. */
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const QUOTE = 0x22
const BACKSLASH = 0x5c

/**
 * Carve the top-level array of records out of an archive, one at a time.
 *
 * Each record's raw text is handed to `onRecord` together with its byte offset
 * in the file, which is what lets the caller turn a match inside the text into
 * an absolute file position.
 *
 * @param options - source path and the per-record callback.
 * @returns how many records were seen.
 */
export async function scanArchive({ sourceFile, onRecord, chunkBytes = CHUNK_BYTES }) {
  const handle = await open(sourceFile, 'r')
  try {
    const buffer = Buffer.alloc(chunkBytes)
    let carry = Buffer.alloc(0)
    let carryOffset = 0
    let depth = 0
    let inString = false
    let escaped = false
    let recordStart = -1
    let count = 0
    let position = 0

    for (;;) {
      const read = await handle.read(buffer, 0, chunkBytes, position)
      if (read.bytesRead === 0) break
      const fresh = buffer.subarray(0, read.bytesRead)
      const combined = carry.length > 0 ? Buffer.concat([carry, fresh]) : fresh
      const base = carry.length > 0 ? carryOffset : position

      if (carry.length > 0) {
        // A carry always begins exactly at a record's opening brace, so the scan
        // restarts from "inside the array". Resetting is what makes this
        // correct: without it the carried text is counted into `depth` a second
        // time, depth runs away, `depth === 2` stops matching, and every record
        // after the first chunk boundary is silently dropped. That is exactly
        // how an earlier version indexed 6 of 960 records.
        depth = 1
        inString = false
        escaped = false
        recordStart = -1
      }

      for (let i = 0; i < combined.length; i += 1) {
        const byte = combined[i]
        if (inString) {
          if (escaped) escaped = false
          else if (byte === BACKSLASH) escaped = true
          else if (byte === QUOTE) inString = false
          continue
        }
        if (byte === QUOTE) {
          inString = true
          continue
        }
        if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
          depth += 1
          if (byte === OPEN_BRACE && depth === 2) recordStart = base + i
          continue
        }
        if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
          if (byte === CLOSE_BRACE && depth === 2 && recordStart >= 0) {
            const start = recordStart - base
            if (start >= 0) {
              onRecord(combined.subarray(start, i + 1).toString('utf8'), recordStart)
              count += 1
            }
            recordStart = -1
          }
          depth -= 1
        }
      }

      // Carry the in-flight record into the next window; when nothing is in
      // flight there is nothing to carry.
      //
      // The copy matters: `combined` is a view into `buffer`, and `buffer` is
      // reused by the next `handle.read`, so a borrowed view would be silently
      // overwritten — which is how an earlier version lost every record past the
      // first chunk boundary.
      const keepFrom = recordStart >= 0 ? recordStart - base : combined.length
      const keep = Math.max(0, keepFrom)
      carry = Buffer.from(combined.subarray(keep))
      carryOffset = base + keep
      position += read.bytesRead
    }
    return count
  } finally {
    await handle.close()
  }
}

/**
 * Locate the byte range of a record's base64 image payload.
 *
 * @param recordText - the record's raw JSON text.
 * @param recordOffset - the record's absolute offset in the file.
 * @returns the payload range, or `null` when the record has no image.
 */
export function locateImage(recordText, recordOffset) {
  const marker = recordText.indexOf(DATA_URL_PREFIX)
  if (marker < 0) return null
  const payload = recordText.indexOf(BASE64_MARKER, marker)
  if (payload < 0) return null
  const start = payload + BASE64_MARKER.length
  const end = recordText.indexOf('"', start)
  if (end < 0 || end <= start) return null
  // `recordText` came from a UTF-8 decode, so character indices can drift from
  // byte offsets for records containing multibyte text. Realign by measuring the
  // prefix that precedes the payload. Base64 is ASCII, so its character count
  // equals its byte count.
  const prefixBytes = Buffer.byteLength(recordText.slice(0, start), 'utf8')
  const mime = /^data:(image\/[a-z+]+);/i.exec(recordText.slice(marker, start))?.[1] ?? 'image/png'
  return {
    start: recordOffset + prefixBytes,
    length: end - start,
    mime
  }
}

/**
 * Locate the base64 payload of one named data-URL field.
 *
 * `locateImage` takes the first data URL in a record, which in these archives is
 * `referenceImage` (about 2 MB). The same records also carry a `thumbnail`
 * (about 36 KB), and a picker grid wants that one, so this finds a field by key.
 *
 * @param recordText - the record's raw JSON text.
 * @param recordOffset - the record's absolute offset in the file.
 * @param field - the JSON key, e.g. `thumbnail`.
 * @returns the payload range, or `null` when the field is absent or not a data URL.
 */
export function locateField(recordText, recordOffset, field) {
  const key = `"${field}"`
  let from = 0
  for (;;) {
    const at = recordText.indexOf(key, from)
    if (at < 0) return null
    const after = at + key.length
    const head = /^\s*:\s*"/.exec(recordText.slice(after, after + 16))
    if (head !== null) {
      const valueStart = after + head[0].length
      if (!recordText.startsWith(DATA_URL_PREFIX, valueStart)) return null
      return locateImage(recordText.slice(valueStart), recordOffset + Buffer.byteLength(recordText.slice(0, valueStart), 'utf8'))
    }
    from = after
  }
}

/**
 * The display group of an archive: its file name without the extension.
 * @param file - the archive path.
 * @returns the group label.
 */
function groupOf(file) {
  return basename(String(file)).replace(/\.json$/i, '')
}

/**
 * Which archive file holds an entry's image bytes.
 *
 * An index built from several archives records the file on every entry. An
 * older single-archive index does not, and then the configured override (for an
 * archive that has moved) or the index's own `sourceFile` applies.
 *
 * @param index - the loaded index.
 * @param entry - one entry of it.
 * @param override - the configured `artistSource`, possibly empty.
 * @returns the archive path.
 */
export function artistSourceOf(index, entry, override = '') {
  if (typeof entry?.source === 'string' && entry.source !== '') return entry.source
  return override || index?.sourceFile || ''
}

/**
 * Build the artist index from one or more archives.
 *
 * Archives are indexed in the order given and keep that order; within one
 * archive entries follow their `sequence`. Collections are often re-shipped
 * with renamed copies of the same style, so an entry whose positive and
 * negative prompts both match one already indexed is dropped, and the archive
 * given first keeps its name for it.
 *
 * @param options - `sourceFile` or `sourceFiles`, and where to write the index.
 * @returns a summary of what was indexed.
 */
export async function buildIndex({ sourceFile, sourceFiles, indexPath, chunkBytes }) {
  const files = (Array.isArray(sourceFiles) && sourceFiles.length > 0 ? sourceFiles : [sourceFile]).filter(
    (file) => typeof file === 'string' && file !== ''
  )
  if (files.length === 0) throw new Error('no archive given')
  const entries = []
  const skipped = []
  const sources = []
  const seen = new Set()
  let duplicates = 0
  for (const file of files) {
    const group = groupOf(file)
    const own = []
    await scanArchive({
      sourceFile: file,
      chunkBytes,
      onRecord: (text, offset) => {
        let record
        try {
          record = JSON.parse(text)
        } catch (error) {
          skipped.push({ file, offset, reason: `unparseable record: ${error.message}` })
          return
        }
        const positivePrompt = typeof record.positivePrompt === 'string' ? record.positivePrompt : ''
        const negativePrompt = typeof record.negativePrompt === 'string' ? record.negativePrompt : ''
        const key = `${positivePrompt.trim()}\u0000${negativePrompt.trim()}`
        if (positivePrompt.trim() !== '' && seen.has(key)) {
          duplicates += 1
          return
        }
        seen.add(key)
        const image = locateImage(text, offset)
        const thumb = locateField(text, offset, 'thumbnail')
        own.push({
          name: typeof record.name === 'string' ? record.name : `#${own.length + 1}`,
          sequence: Number.isFinite(Number(record.sequence)) ? Number(record.sequence) : own.length,
          positivePrompt,
          negativePrompt,
          chamiPositivePrompt: typeof record.chamipositivePrompt === 'string' ? record.chamipositivePrompt : '',
          chamiNegativePrompt: typeof record.chaminegativePrompt === 'string' ? record.chaminegativePrompt : '',
          group,
          source: file,
          image: image === null ? null : { start: image.start, length: image.length, mime: image.mime },
          thumb: thumb === null ? null : { start: thumb.start, length: thumb.length, mime: thumb.mime }
        })
      }
    })
    // Array#sort is stable, so equal sequences keep their order in the file.
    own.sort((a, b) => a.sequence - b.sequence)
    sources.push({ file, group, count: own.length })
    entries.push(...own)
  }

  const index = {
    version: 2,
    // The first archive, so a reader that predates per-entry sources still
    // finds the images of the main collection.
    sourceFile: files[0],
    sources,
    builtAt: new Date().toISOString(),
    entries: entries.map((entry, position) => ({ ...entry, id: position }))
  }
  await mkdir(dirname(indexPath), { recursive: true })
  const temp = `${indexPath}.tmp`
  await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  // Rename so a reader never observes a half-written index.
  await rename(temp, indexPath)
  return {
    count: index.entries.length,
    withImages: index.entries.filter((entry) => entry.image !== null).length,
    withThumbs: index.entries.filter((entry) => entry.thumb !== null).length,
    duplicates,
    sources,
    skipped
  }
}

/**
 * Read the index.
 * @param indexPath - the index path.
 * @returns the parsed index, or `null`.
 */
export async function loadIndex(indexPath) {
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
    if (!Array.isArray(parsed?.entries)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Search the index by name or prompt text.
 *
 * @param index - the loaded index.
 * @param query - the search text; empty returns everything in order.
 * @param limit - maximum results.
 * @param group - optional archive group to restrict to.
 * @returns matching entries without their prompt bodies, for list rendering.
 */
export function searchArtists(index, query, limit = 60, group = '') {
  const needle = String(query ?? '').trim().toLowerCase()
  const rows = []
  for (const entry of index?.entries ?? []) {
    if (group && entry.group !== group) continue
    if (needle !== '' && !`${entry.name} ${entry.positivePrompt}`.toLowerCase().includes(needle)) continue
    // `hasCover`, `edited` and `user` come from the merged view
    // (lib/artist-library.js); a bare index has none of them and reads as false.
    const hasCover = entry.hasCover === true
    rows.push({
      id: entry.id,
      name: entry.name,
      sequence: entry.sequence,
      group: entry.group ?? '',
      hasImage: (entry.image !== null && entry.image !== undefined) || hasCover,
      hasThumb: Boolean(entry.thumb) || hasCover,
      edited: entry.edited === true,
      user: entry.user === true,
      // Changes whenever the cover is replaced, so the panel can bust its image cache.
      coverVersion: hasCover ? String(entry.coverVersion ?? '') : '',
      promptChars: entry.positivePrompt.length
    })
    if (rows.length >= limit) break
  }
  return rows
}

/**
 * Read one reference image out of the archive.
 *
 * @param options - the source file and the entry's image range.
 * @returns the decoded image, or `null` when the range is missing.
 */
export async function readArtistImage({ sourceFile, image }) {
  if (image === null || image === undefined) return null
  const handle = await open(sourceFile, 'r')
  try {
    const buffer = Buffer.alloc(image.length)
    await handle.read(buffer, 0, image.length, image.start)
    return Buffer.from(buffer.toString('ascii'), 'base64')
  } finally {
    await handle.close()
  }
}
