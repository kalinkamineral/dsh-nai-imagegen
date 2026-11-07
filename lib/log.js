/**
 * dsh-nai-imagegen — a local debug log.
 *
 * Every prompt-writing call, render, probe and unexpected failure leaves one
 * JSON line in `STATE_DIR/logs/<YYYY-MM-DD>.jsonl` (local date). The point is
 * the case that started it: a model refused a request for content reasons, the
 * plugin reported "format error", and nothing anywhere showed what the model
 * had actually said.
 *
 * Rules the writer keeps:
 *
 *   - Append-only, one entry per line, writes serialised through one promise
 *     chain so concurrent renders never interleave half lines.
 *   - 14 days are kept; older files go on the first write of a new day. One
 *     day's file stops at 20 MB, with one final `log size cap reached` line.
 *   - Nothing secret and nothing heavy: every entry passes a redactor that
 *     blanks token-like values (`pst-…`, `Bearer …`, fields named token / key /
 *     authorization), replaces data URLs and byte buffers with a short
 *     description, and cuts any string past 12,000 characters.
 *   - `logEvent` never throws and never waits: a full disk must not break a render.
 */
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR } from './config.js'

/** The log directory. */
export const LOG_DIR = join(STATE_DIR, 'logs')
/** How many days of files are kept, today included. */
export const LOG_KEEP_DAYS = 14
/** Ceiling for one day's file. */
export const LOG_MAX_DAY_BYTES = 20 * 1024 * 1024
/** Longest string kept in an entry. */
export const LOG_MAX_STRING = 12000

/** A day file name. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
/** Field names whose values are never written. */
const SECRET_FIELD = /^(?:token|tokens|authorization|api[-_]?key|apikey|password|secret|cookie|bearer|pst)$/i

/** Serialised writes: every append waits for the previous one. */
let chain = Promise.resolve()
/** The day whose old files were already pruned by this process. */
let prunedDay = ''
/** Bytes written per day file, so the cap needs no `stat` per line. */
const sizes = new Map()
/** Days that reached the cap. */
const capped = new Set()

/**
 * The local calendar day of a moment.
 * @param date - the moment (default now).
 * @returns `YYYY-MM-DD`.
 */
export function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Describe a data URL instead of keeping it.
 * @param mime - its media type, possibly empty.
 * @param payload - the base64 payload.
 * @returns `<image: N bytes, image/png>`.
 */
function describeDataUrl(mime, payload) {
  const clean = payload.replace(/\s+/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const bytes = Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
  return `<image: ${bytes} bytes, ${mime || 'unknown'}>`
}

/**
 * Make one string safe to store.
 * @param text - any string.
 * @returns the string without data URLs or token-like values, cut to length.
 */
export function redactString(text) {
  let out = String(text)
    .replace(/data:([a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=._-]+)*;base64,([A-Za-z0-9+/=\s]+)/gi, (_m, mime, payload) =>
      describeDataUrl(mime ?? '', payload)
    )
    .replace(/\bpst-[A-Za-z0-9_-]+/g, 'pst-<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
  if (out.length > LOG_MAX_STRING) {
    out = `${out.slice(0, LOG_MAX_STRING)}…[已截断，原长 ${out.length} 字符]`
  }
  return out
}

/**
 * Make any value safe to store (see the file header).
 * @param value - the value.
 * @param depth - recursion guard.
 * @returns a JSON-safe copy.
 */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<binary: ${value.length} bytes>`
  if (value instanceof Date) return value.toISOString()
  if (depth > 8) return '<nested too deep>'
  if (value instanceof Error) {
    return redact({ message: value.message, code: value.code, ...(value.networkCode ? { networkCode: value.networkCode } : {}) }, depth + 1)
  }
  if (Array.isArray(value)) {
    const rows = value.slice(0, 200).map((row) => redact(row, depth + 1))
    if (value.length > 200) rows.push(`…[另有 ${value.length - 200} 项]`)
    return rows
  }
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) {
      out[key] = inner === null || inner === undefined || inner === '' ? inner ?? null : '<redacted>'
      continue
    }
    const kept = redact(inner, depth + 1)
    if (kept !== undefined) out[key] = kept
  }
  return out
}

/** @returns a short random id, e.g. `k3f9q2xa`. */
function newId() {
  return randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toLowerCase()
}

/**
 * Delete day files older than the retention window.
 * @param now - the reference moment.
 * @returns how many files were removed.
 */
export async function pruneLogs(now = new Date()) {
  const cutoff = localDay(new Date(now.getTime() - (LOG_KEEP_DAYS - 1) * 86400000))
  let removed = 0
  for (const name of await readdir(LOG_DIR).catch(() => [])) {
    const day = DAY_FILE.exec(name)?.[1]
    if (day === undefined || day >= cutoff) continue
    await rm(join(LOG_DIR, name), { force: true })
    sizes.delete(day)
    capped.delete(day)
    removed += 1
  }
  return removed
}

/**
 * Append one line to today's file, minding retention and the size cap.
 * @param line - one JSON line, newline included.
 */
async function writeLine(line) {
  const day = localDay()
  await mkdir(LOG_DIR, { recursive: true })
  if (prunedDay !== day) {
    prunedDay = day
    await pruneLogs()
  }
  if (capped.has(day)) return
  const file = join(LOG_DIR, `${day}.jsonl`)
  if (!sizes.has(day)) sizes.set(day, await stat(file).then((info) => info.size, () => 0))
  const bytes = Buffer.byteLength(line)
  if (sizes.get(day) + bytes > LOG_MAX_DAY_BYTES) {
    capped.add(day)
    const note = `${JSON.stringify({ id: newId(), at: new Date().toISOString(), event: 'log', level: 'warn', summary: '今天的日志已达上限，之后不再记录', message: 'log size cap reached' })}\n`
    await appendFile(file, note, 'utf8')
    sizes.set(day, sizes.get(day) + Buffer.byteLength(note))
    return
  }
  await appendFile(file, line, 'utf8')
  sizes.set(day, sizes.get(day) + bytes)
}

/**
 * Record one event.
 *
 * @param event - `write`, `dna`, `render`, `director`, `probe`, `balance`, `error`, …
 * @param details - `{ level?, summary?, ...fields }`; `level` defaults to
 *   `info`, `summary` (a short Chinese one-liner for the list view) to the event.
 * @returns the entry id (also when the write later fails).
 */
export function logEvent(event, details = {}) {
  const id = newId()
  try {
    const { level = 'info', summary = String(event), ...rest } = details ?? {}
    const entry = redact({
      id,
      at: new Date().toISOString(),
      event: String(event),
      level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
      summary: String(summary),
      ...rest
    })
    const line = `${JSON.stringify(entry)}\n`
    chain = chain.then(() => writeLine(line)).catch(() => {})
  } catch {
    // A value that cannot be serialised costs its entry, never the caller.
  }
  return id
}

/** Wait for every queued write. */
export async function flushLog() {
  await chain
}

/** @returns the day files present, newest first: `[{ day, name }]`. */
async function dayFiles() {
  return (await readdir(LOG_DIR).catch(() => []))
    .map((name) => ({ name, day: DAY_FILE.exec(name)?.[1] }))
    .filter((row) => row.day !== undefined)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
}

/**
 * Parse one day file.
 * @param name - the file name.
 * @returns its entries in file order; broken lines are skipped.
 */
async function readDay(name) {
  const text = await readFile(join(LOG_DIR, name), 'utf8').catch(() => '')
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // a line cut by a crash
    }
  }
  return out
}

/**
 * Read entries, newest first.
 * @param options - `{ limit = 200, event?, level?, since?, day? }`; `event` and
 *   `level` accept a comma-separated list, `since` an ISO time.
 * @returns the entries.
 */
export async function readLog(options = {}) {
  await flushLog()
  const limit = Math.min(5000, Math.max(1, Math.floor(Number(options.limit) || 200)))
  const listOf = (value) =>
    String(value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
  const events = listOf(options.event)
  const levels = listOf(options.level)
  const since = String(options.since ?? '').trim()
  const day = String(options.day ?? '').trim()
  const files = (await dayFiles()).filter((row) => day === '' || row.day === day)
  const out = []
  for (const file of files) {
    const entries = await readDay(file.name)
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]
      if (events.length > 0 && !events.includes(entry.event)) continue
      if (levels.length > 0 && !levels.includes(entry.level)) continue
      if (since !== '' && String(entry.at ?? '') < since) continue
      out.push(entry)
      if (out.length >= limit) return out
    }
  }
  return out
}

/** @returns `[{ day, bytes, count }]`, newest first. */
export async function logDays() {
  await flushLog()
  const out = []
  for (const file of await dayFiles()) {
    const buffer = await readFile(join(LOG_DIR, file.name)).catch(() => Buffer.alloc(0))
    let count = 0
    for (const byte of buffer) if (byte === 0x0a) count += 1
    out.push({ day: file.day, bytes: buffer.length, count })
  }
  return out
}

/**
 * The file of one day, for download.
 * @param day - `YYYY-MM-DD`.
 * @returns the absolute path, or `null` for a malformed day.
 */
export function logFileOf(day) {
  const value = String(day ?? '')
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? join(LOG_DIR, `${value}.jsonl`) : null
}

/**
 * Delete every log file.
 * @returns how many files were removed.
 */
export async function clearLog() {
  await flushLog()
  let removed = 0
  for (const file of await dayFiles()) {
    await rm(join(LOG_DIR, file.name), { force: true })
    removed += 1
  }
  sizes.clear()
  capped.clear()
  // The next write starts a fresh day: it prunes again.
  prunedDay = ''
  return removed
}

/**
 * The start and the end of a long text, for an entry that must stay readable.
 * @param text - the text.
 * @param head - characters kept from the start.
 * @param tail - characters kept from the end (only when the text is longer than both).
 * @returns `{ head, tail }`; `tail` is `''` when the head already covers it all.
 */
export function headTail(text, head = 1500, tail = 500) {
  const value = String(text ?? '')
  if (value.length <= head + tail) return { head: value, tail: '' }
  return { head: value.slice(0, head), tail: value.slice(-tail) }
}
