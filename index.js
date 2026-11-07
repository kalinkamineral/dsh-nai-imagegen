/**
 * dsh-nai-imagegen — Host half.
 *
 * Two contributions, one connection:
 *
 *   1. `nai_*` tools, so the Agent can search the five 附体 libraries and render
 *      an image on demand. A render lands as a PNG in the configured output
 *      directory and the tool returns that path, which lets the Agent embed it
 *      in its reply with ordinary Markdown — that is how an image ends up in the
 *      conversation body rather than only in a file card.
 *
 *   2. A loopback HTTP API under `/nai-imagegen/api`, so the browser half can
 *      show and edit the same configuration and browse what was rendered.
 *
 * Why the browser half does not call NovelAI itself: it has no CORS-free origin
 * and no business holding the token. The token never leaves this process — the
 * API reports only whether one is in force and where it came from.
 *
 * Deliberately dependency-free apart from the two DSH services it injects.
 */
import { readdir, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { LIBRARIES, MODE_FIELDS, MODE_NAMES, load, outputDirOf, save, sourceDirOf, tokenOf } from './lib/config.js'
import { DIRECTOR_TYPES, FREE_AREA, MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS, acceptForDecode, augmentImage, costWeight, formatBalance, generate, insideFreeBand, legalAxis, noiseScheduleFor, persist, probe, proxyFor, readBaseImage, sniffImage, systemProxy, systemProxyInfo } from './lib/nai.js'
import { listLibraries, lookup, rebuildIndex, resolveCharacter } from './lib/library.js'
import { digest, safeJoin } from './lib/util.js'
import { defineTool } from './lib/tool.js'
import { createPool, fingerprintOf } from './lib/keypool.js'
import { artistSourceOf, buildIndex, loadIndex, readArtistImage, searchArtists } from './lib/artists.js'
import { captionPage } from './lib/caption.js'
import { looksLikeImageBlock, maybeParseImageBlock, parseImageBlock } from './lib/format.js'
import { looksLikeAnyPage, looksLikeComicPage, maybeParseComicPage, parseComicPage } from './lib/comic.js'
import { RECIPE_GROUPS, describeRecipe, normalizeRecipe, recipeFragments } from './lib/recipe.js'
import { formatDoctor, runDoctor } from './lib/doctor.js'
import { applyUcPreset, ucPresetText } from './lib/uc-presets.js'
import { qualityTagText } from './lib/quality-tags.js'
import { llmModels, llmStatus } from './lib/llm.js'
import { dnaFromImage, loadPresets, resetPreset, savePresets, writePrompt } from './lib/writer.js'
import { editCharacter, mergeEditDraft } from './lib/character-edit.js'
import { estimateView, generateView, listItems, panelView, probeView, stripText, toolCard } from './lib/dsh-go.js'
import {
  characterCoverFile,
  deleteCharacter,
  deleteCharacterCover,
  deleteGroup,
  exportCharacters,
  importCharacters,
  loadCharacters,
  promptTags,
  saveCharacter,
  saveGroup,
  setCharacterCover,
  substituteKeywords,
  withCoverFlags
} from './lib/characters.js'
import { importMarket, loadMarket } from './lib/market.js'
import { MODEL_OPTIONS, inpaintingModelFor, modelFamily } from './lib/models.js'
import { LOG_DIR, clearLog, flushLog, logDays, logEvent, logFileOf, readLog } from './lib/log.js'
import { artistById, coverFileOf, deleteUserArtist, loadArtists, saveUserArtist, setArtistCover } from './lib/artist-library.js'
import { randomUUID } from 'node:crypto'

/** Directory/state name; also this plugin's profile entry id. */
export const ROW_ID = 'nai-imagegen'
/** Absolute path prefix of this plugin's HTTP API. */
const API_PREFIX = '/nai-imagegen/api'
/** Request body ceiling for one config or generate call. */
const MAX_BODY_BYTES = 256 * 1024
/** Ceiling for a base image uploaded from the browser's file picker. */
const MAX_UPLOAD_BYTES = MAX_SOURCE_BYTES + 1024
/** JSON ceiling for an inpaint call: a base image and a mask as data URLs. */
const MAX_INPAINT_BODY_BYTES = 8 * 1024 * 1024
/** Newest-first page size ceiling for the gallery. */
const MAX_GALLERY = 600
/**
 * JSON ceiling for a call that carries one reference image as a data URL. The
 * workbench accepts pictures up to 8 MB, which is ~10.7 MB once base64-encoded.
 */
const MAX_IMAGE_BODY_BYTES = 12 * 1024 * 1024
/** JSON ceiling for an imported character file or tag-market catalog. */
const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024

/** Required services: the HTTP carrier and the model-facing tool registry. */
export const inject = ['webServer', 'tools']

/** Pure text projection helper shared by every tool below. */
function textRender(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }]
}

/**
 * List image files in a directory, newest first, paginated.
 *
 * Pagination lives on the Host so the pickers stay cheap: one page is read and
 * returned at a time, so a 700-image directory costs the same as a 7-image one
 * until the user asks for more.
 *
 * @param directory - absolute directory.
 * @param options - `{ limit, offset, extensions }`.
 * @returns `{ files, total }`, where total counts every matching file.
 */
async function listImages(directory, { limit = 120, offset = 0, extensions = ['.png'], all = false }) {
  let names = []
  try {
    names = await readdir(directory)
  } catch {
    return { files: [], total: 0 }
  }
  const rows = []
  for (const name of names) {
    if (!extensions.some((extension) => name.toLowerCase().endsWith(extension))) continue
    try {
      const info = await stat(join(directory, name))
      if (info.isFile()) rows.push({ name, bytes: info.size, mtime: info.mtimeMs })
    } catch {
      // A file that vanished mid-scan only drops itself.
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  // `all` lifts the page ceiling, for whole-directory work (stats, trim).
  const pageSize = all ? rows.length : Math.min(MAX_GALLERY, Math.max(1, Math.floor(Number(limit) || 120)))
  const start = Math.max(0, Math.floor(Number(offset) || 0))
  return { files: rows.slice(start, start + pageSize), total: rows.length }
}

/**
 * The batch stamp of a gallery file name. `persist` writes `<stamp>.png` for one
 * image and `<stamp>-N.png` for a batch, with one `<stamp>.json` per call; the
 * stamp ends in `Z`, which is how a batch suffix is told from its own dashes.
 * @param name - a PNG file name.
 * @returns the stamp (the sidecar's name without `.json`).
 */
function batchStampOf(name) {
  const stem = name.replace(/\.png$/i, '')
  return /^(.*Z)-\d+$/.exec(stem)?.[1] ?? stem
}

/**
 * Add `width`, `height` and `seed` to gallery rows from their sidecars, read
 * once per batch. Rows without a sidecar keep only what `stat` gave.
 * @param directory - the output directory.
 * @param rows - `[{ name, bytes, mtime }]`.
 * @returns the rows, enriched.
 */
async function withRenderMeta(directory, rows) {
  const sidecars = new Map()
  const sidecarOf = async (stamp) => {
    if (!sidecars.has(stamp)) {
      sidecars.set(
        stamp,
        readFile(join(directory, `${stamp}.json`), 'utf8')
          .then((text) => JSON.parse(text))
          .catch(() => null)
      )
    }
    return sidecars.get(stamp)
  }
  return Promise.all(
    rows.map(async (row) => {
      const meta = await sidecarOf(batchStampOf(row.name))
      const file = Array.isArray(meta?.files) ? meta.files.find((entry) => entry?.name === row.name) : undefined
      const size = /^(\d+)x(\d+)$/.exec(String(file?.size ?? ''))
      const width = size ? Number(size[1]) : Number(meta?.request?.width) || undefined
      const height = size ? Number(size[2]) : Number(meta?.request?.height) || undefined
      const seed = typeof file?.seed === 'number' ? file.seed : undefined
      return { ...row, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(seed !== undefined ? { seed } : {}) }
    })
  )
}

/**
 * Delete gallery PNGs, and a batch's sidecar once no PNG of that batch is left.
 * Covers copied from a render are separate files and stay.
 * @param directory - the output directory.
 * @param names - PNG file names (each validated: a plain name, inside the directory).
 * @returns `{ deleted: [names], missing: [names] }`.
 */
async function deleteRenders(directory, names) {
  const deleted = []
  const missing = []
  const stamps = new Set()
  for (const name of names) {
    const file = safeJoin(directory, name)
    if (!/\.png$/i.test(name)) throw Object.assign(new Error(`只能删除图库里的 PNG：${name}`), { status: 400 })
    try {
      await rm(file)
      deleted.push(name)
      stamps.add(batchStampOf(name))
    } catch (error) {
      if (error?.code === 'ENOENT') missing.push(name)
      else throw error
    }
  }
  if (stamps.size > 0) {
    const left = new Set((await readdir(directory).catch(() => [])).filter((name) => /\.png$/i.test(name)).map(batchStampOf))
    for (const stamp of stamps) {
      if (!left.has(stamp)) await rm(join(directory, `${stamp}.json`), { force: true })
    }
  }
  return { deleted, missing }
}

/**
 * Keep only the newest `keepImages` renders (0 = keep everything).
 *
 * `keepImages` was documented as "keep only the newest N images on disk" but was
 * never applied, so the output directory grew without bound. Runs after a save;
 * the files just written are always among the newest, and a failure here only
 * leaves extra files behind — it must never fail the render that triggered it.
 * @param config - the loaded configuration.
 * @param outputDir - the output directory.
 */
async function enforceKeepImages(config, outputDir) {
  const keep = Number(config.keepImages)
  if (!Number.isInteger(keep) || keep <= 0) return
  try {
    const all = await listImages(outputDir, { limit: Number.MAX_SAFE_INTEGER, extensions: ['.png'], all: true })
    if (all.files.length > keep) await deleteRenders(outputDir, all.files.slice(keep).map((row) => row.name))
  } catch {
    /* extra files stay; the next save tries again */
  }
}

/**
 * Read the gallery: every PNG in the output directory, newest first.
 * @param outputDir - absolute output directory.
 * @param limit - page size.
 * @returns newest-first file rows.
 */
async function gallery(outputDir, limit) {
  return (await listImages(outputDir, { limit, extensions: ['.png'] })).files
}

/** Extensions the img2img source listing accepts. */
const SOURCE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

/**
 * List the base images `nai_img2img` may read (one page).
 *
 * Kept separate from `gallery()` because the two directories mean different
 * things: the gallery is PNG-only output, while a base image may be any of the
 * formats `readBaseImage` sniffs — including a JPEG the user dropped in by hand.
 *
 * @param sourceDir - absolute source directory.
 * @param limit - page size.
 * @param offset - first row to return.
 * @returns newest-first file rows.
 */
export async function sourceListing(sourceDir, limit, offset = 0) {
  return (await listImages(sourceDir, { limit, offset, extensions: SOURCE_EXTENSIONS })).files
}

/**
 * Read a request body as JSON, bounded.
 * @param req - the node request.
 * @returns the parsed body, or `{}` when the body is empty.
 */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`request body too large (limit ${Math.round(limit / 1024)}KB)`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object') throw new Error('request body must be a JSON object')
  return parsed
}

/**
 * Read a request body as raw bytes, bounded.
 *
 * The base image arrives from the browser's file picker as an octet-stream, not
 * as a JSON field: base64 inside JSON would inflate a 10 MB image past the
 * config endpoint's 256 KB ceiling and add a second copy in memory.
 *
 * @param req - the node request.
 * @param limit - byte ceiling for the whole body.
 * @returns the body bytes.
 */
async function readBinaryBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`上传文件超过 ${Math.round(limit / 1048576)}MB 上限`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Extension forced from the sniffed MIME type, so a renamed file cannot lie. */
const EXTENSION_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

/**
 * Reduce a browser-supplied file name to a safe leaf name.
 * @param name - the requested name.
 * @returns a name without path separators or Windows-reserved characters.
 */
function safeSourceName(name) {
  const leaf = basename(String(name ?? '').replace(/\\/g, '/'))
  const cleaned = leaf.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') throw new Error('文件名无效')
  return cleaned
}

/**
 * Choose a file name that does not overwrite an existing source image.
 * @param sourceDir - the source directory.
 * @param requested - the preferred name, extension included.
 * @returns the first free name.
 */
async function uniqueSourceName(sourceDir, requested) {
  const extension = extname(requested)
  const stem = requested.slice(0, requested.length - extension.length)
  const taken = new Set(await readdir(sourceDir).catch(() => []))
  let candidate = requested
  for (let n = 1; taken.has(candidate); n += 1) candidate = `${stem}-${n}${extension}`
  return candidate
}

/**
 * The `-inpainting` sibling of a model id (or the id itself when it already is
 * one). NovelAI refuses infill on a normal model, and the id is what decides it.
 * @param model - the configured or requested model id.
 * @returns the inpainting model id.
 */
function inpaintModelOf(model) {
  // lib/models.js knows the two ids where appending `-inpainting` names a model
  // that does not exist (V5 Curated, V4 Curated preview).
  return inpaintingModelFor(model).model
}

/**
 * Decode one base64 image field carried in a JSON body.
 * @param value - a data URL or bare base64 string.
 * @param field - field name, used in errors and as the recorded name.
 * @returns the same shape `readBaseImage` returns.
 */
function decodeInlineImage(value, field) {
  const raw = String(value ?? '')
    .replace(/^data:[^;]+;base64,/, '')
    .trim()
  if (raw === '') throw new Error(`${field} 为空`)
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length === 0) throw new Error(`${field} 解码为空`)
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`${field} 超过 ${Math.round(MAX_SOURCE_BYTES / 1048576)}MB 上限`)
  const sniffed = sniffImage(bytes)
  if (sniffed === null) throw new Error(`${field} 不是 PNG/JPEG/WebP`)
  return { base64: raw, mime: sniffed.mime, width: sniffed.width, height: sniffed.height, bytes: bytes.length, name: field }
}

/**
 * Decode the mask field. The alpha channel marks the region, so the encoding has
 * to be PNG — a JPEG mask would lose the transparency that defines the edit.
 * @param value - a data URL or bare base64 string.
 * @returns the decoded mask.
 */
function decodeInlineMask(value) {
  const mask = decodeInlineImage(value, 'mask')
  if (mask.mime !== 'image/png') throw new Error('mask 必须是 PNG（用 alpha 通道标记重绘区）')
  if (mask.width === null || mask.height === null) throw new Error('mask 尺寸无法解析')
  return mask
}

/**
 * Run one Director Tool over an image kept in the plugin's own directories.
 *
 * The endpoint requires `width`/`height` to equal the input's real dimensions
 * (a mismatch is an opaque 500), so they are sniffed from the file rather than
 * taken from the caller. The result is persisted like a render so it shows up in
 * the gallery and can be embedded from the reply.
 *
 * @param options - `{ from, name, type, prompt?, emotion?, defry?, signal? }`.
 * @returns the written file records.
 */
async function runDirectorTool(options) {
  const { from = 'gallery', name, type, prompt = null, emotion = null, defry = null, signal } = options
  if (!DIRECTOR_TYPES.includes(type)) {
    throw new Error(`不支持的导演工具：${type}（可用：${DIRECTOR_TYPES.join(' / ')}）`)
  }
  const config = await load()
  const directory = from === 'source' ? await sourceDirOf(config) : await outputDirOf(config)
  const bytes = await readFile(safeJoin(directory, String(name ?? '')))
  const sniffed = sniffImage(bytes)
  if (sniffed === null || sniffed.width === null || sniffed.height === null) {
    throw new Error('导演工具：输入不是可识别的图片')
  }
  const image = await augmentImage({
    baseUrl: config.baseUrl,
    token: await tokenOf(config),
    proxy: proxyFor(config),
    connectTimeoutMs: config.connectTimeoutMs,
    signal,
    type,
    image: bytes,
    width: sniffed.width,
    height: sniffed.height,
    prompt,
    emotion,
    defry
  })
  const outputDir = await outputDirOf(config)
  const written = await persist({
    outputDir,
    images: [image],
    request: {
      action: 'director',
      tool: type,
      from,
      source: String(name ?? ''),
      width: sniffed.width,
      height: sniffed.height,
      ...(prompt === null ? {} : { prompt }),
      ...(emotion === null ? {} : { emotion })
    }
  })
  await enforceKeepImages(config, outputDir)
  return written
}

/**
 * Send one JSON response.
 * @param res - the node response.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

/**
 * Send one failure. A thrown error may carry an HTTP `status` and extra fields
 * the panel can show (`code`, `issues`, `raw`, `attempts`, `route`); anything
 * else is a plain 400, as before.
 * @param res - the node response.
 * @param error - what was thrown.
 */
function sendError(res, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 400
  const body = { error: error?.message ?? String(error) }
  // `logId` points at the debug-log entry (GET /logs) that holds the details.
  for (const field of ['code', 'networkCode', 'issues', 'raw', 'attempts', 'route', 'refusal', 'reason', 'characters', 'logId']) {
    if (error?.[field] !== undefined && error[field] !== null) body[field] = error[field]
  }
  sendJson(res, status, body)
}

/**
 * Run one render and leave one `render` entry in the debug log either way.
 *
 * @param kind - `generate`, `img2img`, `inpaint`, `preview` (and `tool:*` for the
 *   Agent's tools).
 * @param options - `renderNow`'s options.
 * @returns `renderNow`'s result, plus `logId`.
 * @throws `renderNow`'s error, with `logId` set.
 */
/**
 * Live download progress of panel renders, keyed by the short random id the
 * panel sends with a render. The panel polls `/render-progress`; an entry is
 * kept for two minutes after the render ends so a last poll still answers.
 */
const renderProgress = new Map()
/** How long a finished entry stays readable, in ms. */
const RENDER_PROGRESS_TTL_MS = 120000

/**
 * Start tracking one panel render.
 * @param requestId - the client-supplied id (already format-checked).
 * @returns `{ entry, onProgress, finish }`; the entry is what `/render-progress`
 *   returns, `onProgress` goes down to `generate`, `finish` seals it.
 */
function trackRenderProgress(requestId) {
  const entry = { id: requestId, status: 'waiting', startedAt: Date.now(), firstByteMs: null, received: 0, total: null, updatedAt: Date.now() }
  renderProgress.set(requestId, entry)
  const finish = (status) => {
    entry.status = status
    entry.updatedAt = Date.now()
    const timer = setTimeout(() => {
      if (renderProgress.get(requestId) === entry) renderProgress.delete(requestId)
    }, RENDER_PROGRESS_TTL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const onProgress = (info) => {
    entry.received = Number(info?.received) || 0
    entry.total = info?.total === undefined || info?.total === null ? null : Number(info.total)
    // TTFB is when the response headers arrived: the model had produced the
    // image and the relay started answering. Everything after that is transfer.
    if (info?.headers === true && entry.firstByteMs === null) entry.firstByteMs = Date.now() - entry.startedAt
    if (entry.received > 0 && entry.firstByteMs === null) entry.firstByteMs = Date.now() - entry.startedAt
    entry.status = 'downloading'
    entry.updatedAt = Date.now()
  }
  return { entry, onProgress, finish }
}

async function renderLogged(kind, options) {
  const started = Date.now()
  const trace = {}
  // Every render gets TTFB/bytes in the log, panel or tool: when a render is kept
  // waiting by the relay's download, the entry itself says so instead of a bare
  // wall-clock number.
  const progress = options.progress ?? { firstByteMs: null, received: 0, total: null }
  const onProgress =
    typeof options.onProgress === 'function'
      ? options.onProgress
      : (info) => {
          progress.received = Number(info?.received) || 0
          progress.total = info?.total === undefined || info?.total === null ? null : Number(info.total)
          if (info?.headers === true && progress.firstByteMs === null) progress.firstByteMs = Date.now() - started
          if (progress.received > 0 && progress.firstByteMs === null) progress.firstByteMs = Date.now() - started
        }
  const facts = () => ({
    kind,
    model: trace.model ?? options.model ?? null,
    width: trace.width ?? null,
    height: trace.height ?? null,
    steps: trace.steps ?? null,
    nSamples: trace.nSamples ?? null,
    characters: trace.characters ?? null,
    artistId: trace.artistId ?? null,
    artistName: trace.artistName ?? null,
    seed: trace.seed ?? null,
    promptHead: String(trace.prompt ?? options.prompt ?? '').slice(0, 600),
    // Slow-transfer diagnosis: the relay can accept a render and then trickle the
    // PNG back for minutes. These say whether the wait was the model or the
    // download, without keeping the bytes.
    ttfbMs: Number.isFinite(progress.firstByteMs) ? progress.firstByteMs : null,
    bytes: Number.isFinite(progress.received) ? progress.received : null,
    ms: Date.now() - started
  })
  try {
    const result = await renderNow({ ...options, trace, progress, onProgress })
    const logId = logEvent('render', {
      level: 'info',
      summary: `出图 ${result.files.length} 张 · ${trace.model ?? '?'} · ${trace.width}×${trace.height} · ${((Date.now() - started) / 1000).toFixed(1)} 秒`,
      ...facts(),
      outcome: 'ok',
      seed: result.files[0]?.seed ?? trace.seed ?? null,
      files: result.files.map((file) => file.name)
    })
    return { ...result, logId }
  } catch (error) {
    const aborted = Number(error?.statusCode) === 499 || options.signal?.aborted === true
    error.logId = logEvent('render', {
      level: aborted ? 'info' : 'error',
      summary: aborted ? '出图已取消' : `出图失败${error?.code ? `（${error.code}）` : ''}：${String(error?.message ?? error).slice(0, 80)}`,
      ...facts(),
      outcome: aborted ? 'aborted' : 'error',
      error: String(error?.message ?? error),
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.networkCode ? { networkCode: error.networkCode } : {})
    })
    throw error
  }
}

/**
 * Log a request refused before any work started (a bad body), so its error body
 * can carry a `logId` like every other failure.
 * @param event - the event name.
 * @param message - the error text.
 * @param details - extra fields.
 * @returns an Error with `status: 400` and `logId`.
 */
function loggedBadRequest(event, message, details = {}) {
  const logId = logEvent(event, { level: 'warn', summary: `请求被拒：${message.slice(0, 80)}`, outcome: 'rejected', error: message, ...details })
  return Object.assign(new Error(message), { status: 400, logId })
}

/**
 * The workbench-only render options of a `/generate` or `/inpaint` body. Each is
 * forwarded only when the body carries it, because "absent" has its own meaning
 * (absent `artistOverride` = the stored artist; absent sampling knob = the
 * configured default).
 * @param body - the parsed request body.
 * @returns the options to spread into `renderNow`.
 */
function workbenchOptions(body) {
  const out = {}
  if (typeof body.replaceCharacterKeywords === 'boolean') out.replaceCharacterKeywords = body.replaceCharacterKeywords
  if (Object.prototype.hasOwnProperty.call(body, 'artistOverride')) out.artistOverride = body.artistOverride
  // The workbench picks its own artist entry rather than following the global one.
  if (body.artistId !== undefined && body.artistId !== null && Number.isInteger(Number(body.artistId))) out.artistId = Number(body.artistId)
  if (body.cfgRescale !== undefined && body.cfgRescale !== null) out.cfgRescale = Number(body.cfgRescale)
  if (typeof body.noiseSchedule === 'string' && body.noiseSchedule !== '') out.noiseSchedule = body.noiseSchedule
  if (typeof body.variety === 'boolean') out.variety = body.variety
  if (typeof body.transparentBackground === 'boolean') out.transparentBackground = body.transparentBackground
  if (typeof body.smea === 'string' && body.smea !== '') out.smea = body.smea
  return out
}

/**
 * Read the sidecar JSON written beside a render.
 *
 * `persist` names a single image `<stamp>.png` and a batch `<stamp>-N.png`,
 * with one `<stamp>.json` for the whole call; the stamp itself ends in `Z`, which
 * is how a batch suffix is told apart from the stamp's own dashes.
 *
 * @param pngPath - the image's absolute path (already validated).
 * @returns the parsed sidecar, or `null`.
 */
async function readSidecar(pngPath) {
  const stem = pngPath.slice(0, pngPath.length - extname(pngPath).length)
  const candidates = [`${stem}.json`]
  const batch = /^(.*Z)-\d+$/.exec(stem)
  if (batch !== null) candidates.push(`${batch[1]}.json`)
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8'))
    } catch {
      // try the next candidate
    }
  }
  return null
}

/**
 * An abort signal that fires when the client goes away before the answer is
 * written, so closing the panel (or pressing 取消) stops a running model call.
 *
 * Listens on the *response*: since Node 16 the request's own `close` fires as
 * soon as its body has been read, which would abort every call immediately. A
 * response closes either after it was sent (`writableEnded`, ignored) or when
 * the socket drops first.
 *
 * @param res - the node response.
 * @returns the signal.
 */
function disconnectSignal(res) {
  const controller = new AbortController()
  if (typeof res?.on === 'function') {
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('请求已取消'))
    })
  }
  return controller.signal
}

/**
 * Describe the live configuration for both the model and the panel. The token
 * itself is never returned — only whether one is in force and where from.
 * @returns the status payload.
 */
async function statusPayload() {
  const config = await load()
  const token = await tokenOf(config)
  const outputDir = await outputDirOf(config)
  const sourceDir = await sourceDirOf(config)
  const images = await gallery(outputDir, 120)
  const libraries = await listLibraries(config.libraryDir)
  const activePool = poolFor(config)
  // The merged view: archive entries with the user's edits, plus 「我的画师串」.
  const artists = await loadArtists(config)
  return {
    rowId: ROW_ID,
    baseUrl: config.baseUrl,
    model: config.model,
    /** Response format asked of the relay: zip | json | auto. */
    decode: config.decode ?? 'zip',
    width: config.width,
    height: config.height,
    steps: config.steps,
    scale: config.scale,
    sampler: config.sampler,
    ucPreset: config.ucPreset,
    /**
     * 头部插入的文字（放到正向最前面）。面板要能回显它，否则用户改过之后
     * 看不到当前值，会重复填写。
     */
    header: config.header ?? '',
    /** 官方质量词开关（默认关）。面板要能回显它，否则勾选状态看不出来。 */
    qualityToggle: config.qualityToggle === true,
    // The effective proxy, so the panel can show what will actually be used
    // rather than just what was configured.
    proxy: proxyFor(config),
    proxySetting: config.proxy,
    detectedProxy: systemProxy(),
    /**
     * The route renders take, and what Windows records. `system.server` is kept
     * even when the switch is off, because "recorded but off" is the case where
     * the direct route hangs and the panel has to say so.
     */
    network: (() => {
      const system = systemProxyInfo()
      return { proxy: proxyFor(config), proxySetting: config.proxy, system: { enabled: system.enabled, server: system.server } }
    })(),
    connectTimeoutMs: config.connectTimeoutMs,
    /** The selectable models, one table shared with the inpainting mapping. */
    models: MODEL_OPTIONS,
    /** Where the debug log (GET /logs) is written. */
    logDir: LOG_DIR,
    outputDir,
    sourceDir,
    libraryDir: config.libraryDir,
    librarySourceDir: config.librarySourceDir,
    artistIndex: config.artistIndex,
    artistSource: config.artistSource || artists.sourceFile || '',
    artistCount: artists.entries.length,
    /**
     * The archives the index was built from, in order, with their entry counts,
     * then 「我的画师串」 when the user has saved any.
     */
    artistGroups: artists.groups.map((row) => ({ group: row.group, count: row.count, ...(row.user ? { user: true } : {}) })),
    artistId: Number(config.artistId),
    artistName: artistById(artists, config.artistId)?.name ?? null,
    // Key state travels as labels and fingerprints only; tokens stay in the host.
    keys: activePool.list(),
    keySummary: activePool.healthSummary(),
    autoGenerate: config.autoGenerate === true,
    codeButtons: config.codeButtons === true,
    mode: config.mode,
    /** The override field names, so the floating window and the host share one list. */
    modeFields: Object.keys(MODE_FIELDS),
    /**
     * What each mode actually renders with once the overrides are resolved.
     *
     * The floating window shows these rather than the raw overrides, because the
     * question being answered is "what will this mode do", not "what did I type".
     */
    modeSettings: MODE_NAMES.map((name) => {
      const effective = settingsFor(config, name)
      const style = artistById(artists, effective.artistId)
      return {
        mode: name,
        // The per-mode override window is retired; keep the row shape for older
        // clients, but report the shared defaults that are actually used.
        overrides: {},
        artistId: Number(effective.artistId),
        artistName: style?.name ?? null,
        width: effective.width,
        height: effective.height,
        steps: effective.steps,
        model: effective.model,
        sampler: effective.sampler,
        scale: effective.scale,
        ucPreset: effective.ucPreset,
        negativePrompt: effective.negativePrompt,
        header: effective.header ?? '',
        qualityToggle: effective.qualityToggle === true,
        // The comic recipe, resolved: the option labels it picked and the page count
        // the writer should aim for. Sent so the floating window shows the state in
        // force rather than only what was stored.
        recipe: normalizeRecipe(effective.recipe),
        recipeText: describeRecipe(effective.recipe),
        recipePages: effective.mode === 'comic' ? recipeFragments(effective.recipe).pages : 0,
        /** The option table itself, so the window and the host share one list. */
        recipeGroups: RECIPE_GROUPS,
        maxImagesPerCall: effective.maxImagesPerCall
      }
    }),
    maxImagesPerCall: config.maxImagesPerCall,
    keepImages: config.keepImages,
    // Sampling defaults the workbench's params form starts from.
    cfgRescale: config.cfgRescale,
    noiseSchedule: config.noiseSchedule,
    variety: config.variety === true,
    transparentBackground: config.transparentBackground === true,
    smea: config.smea,
    // The prompt writer's model route ('' + '' = DSH's default model) and limits.
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    llmMaxTokens: config.llmMaxTokens,
    writerRetries: config.writerRetries,
    tokenSet: token.length > 0,
    tokenSource: (process.env.NAI_TOKEN || '').trim() ? 'env' : token ? 'file' : 'none',
    negativePrompt: config.negativePrompt,
    imageCount: images.length,
    libraries: libraries.length > 0 ? libraries : LIBRARIES.map((library) => ({ library, entries: 0 })),
    newest: images.slice(0, 12)
  }
}

/**
 * Probe NovelAI, preferring the key pool.
 *
 * The pool is the source of truth for credentials. Reading the single `tokenOf`
 * value instead would report "not configured" the moment the legacy `token`
 * field is folded into the managed key list — which happens on the first add or
 * remove from the panel — even with four healthy keys sitting in the pool.
 *
 * @param options - an optional abort signal.
 * @returns the probe outcome, plus a pool summary.
 */
async function probeNow(options = {}) {
  const config = await load()
  const activePool = poolFor(config)
  const pool = activePool.healthSummary()
  if (activePool.configured()) {
    try {
      // Outside the render queue: a probe asks "can I reach NovelAI at all", and
      // waiting behind a render stuck on a dead route is exactly when it is needed.
      const result = await activePool.bypass({ kind: 'probe' }, { signal: options.signal })
      return { ...result, pool: activePool.healthSummary() }
    } catch (error) {
      // renderOne throws the probe's own outcome for failures; keep its fields.
      if (error?.probe) return { ...error.probe, pool: activePool.healthSummary() }
      return {
        ok: false,
        stage: 'network',
        detail: error.message,
        status: Number(error.statusCode) || 0,
        ...(error.code ? { code: error.code } : {}),
        hint: error.hint ?? '',
        pool: activePool.healthSummary()
      }
    }
  }
  const token = await tokenOf(config)
  const result = await probe({ baseUrl: config.baseUrl, token, proxy: proxyFor(config), signal: options.signal })
  return { ...result, pool }
}

/**
 * The balance part of a probe's subscription record.
 * @param subscription - `result.subscription`, possibly `null`.
 * @returns `{ tier, anlas: { fixed, purchased, total }, energy }` or `null`.
 */
function balanceOf(subscription) {
  if (subscription === null || subscription === undefined || subscription.anlas === undefined) return null
  return { tier: subscription.tier ?? null, anlas: subscription.anlas, energy: subscription.energy ?? null }
}

/**
 * Probe every key once, in parallel, outside the render queue. Failures are
 * recorded on the keys themselves (status, last error), so nothing is returned.
 * @param activePool - the key pool.
 * @param signal - optional abort signal.
 */
async function verifyKeys(activePool, signal) {
  await Promise.all(activePool.list().map((key) => activePool.bypass({ kind: 'probe' }, { keyId: key.id, signal }).catch(() => null)))
}

/**
 * The shared key pool, rebuilt only when the configured key set changes so that
 * cooldown and failure state survives across calls instead of resetting.
 */
let pool = null
let poolSignature = ''

/**
 * Get the key pool for a configuration.
 *
 * `NAI_TOKEN`, when set, takes over the primary slot (matching the documented
 * precedence) while the configured extra keys stay in play. The pool is rebuilt
 * whenever the key set changes, and only then.
 *
 * @param config - the loaded configuration.
 * @returns the pool.
 */
function poolFor(config) {
  const envToken = (process.env.NAI_TOKEN ?? '').trim()
  const primary = envToken !== '' ? envToken : String(config.token ?? '')
  const signature = [primary, ...(config.keys ?? []).map((entry) => `${entry.label}:${entry.token}:${entry.enabled}`)].join('|')
  if (pool === null || signature !== poolSignature) {
    pool = createPool({ token: primary, keys: config.keys ?? [] }, { call: renderOne })
    poolSignature = signature
  }
  return pool
}

/**
 * Rewrite the managed key list, folding the legacy single `token` in on the way.
 *
 * The panel addresses keys by id, and a bare `token` field has no id, so the
 * first key-management write migrates it into the list and clears the field.
 * After that every key is uniform, and `NAI_TOKEN` still overrides the primary
 * slot at pool-build time.
 *
 * @param mutate - receives a mutable copy of the key list and returns the new one.
 * @returns the stored list.
 */
async function persistKeys(mutate) {
  const config = await load()
  // The ids the panel already saw, indexed by token fingerprint. Without this a
  // config written before ids existed would get fresh ones on the first write,
  // and every click the user made against the old ids would miss.
  const known = new Map(poolFor(config).list().map((key) => [key.fingerprint, key.id]))
  const keys = (Array.isArray(config.keys) ? config.keys : []).map((key) => ({ ...key }))
  const legacy = String(config.token ?? '').trim()
  if (legacy !== '' && !keys.some((key) => fingerprintOf(key.token) === fingerprintOf(legacy))) {
    keys.unshift({ label: '主 Key（原单一 token）', token: legacy, enabled: true })
  }
  for (const key of keys) {
    if (typeof key.id === 'string' && key.id !== '') continue
    key.id = known.get(fingerprintOf(key.token)) ?? randomUUID()
  }
  const next = mutate(keys)
  await save({ keys: next, token: '' })
  return next
}

/**
 * Render exactly one image with one key — the pool's unit of work.
 *
 * Also serves key verification: a `{ kind: 'probe' }` payload reads the
 * subscription record instead of rendering, and throws with a status code so the
 * pool applies the same classification it uses for renders.
 *
 * @param payload - the request parameters, without a token.
 * @param token - the key the pool chose.
 * @param signal - the pool's abort signal.
 * @returns the first image buffer, or the probe outcome.
 */
async function renderOne(payload, token, signal) {
  const config = await load()
  const proxy = proxyFor(config)
  if (payload.kind === 'probe') {
    const result = await probe({ baseUrl: config.baseUrl, token, proxy, signal })
    if (!result.ok && result.stage !== 'reachable') {
      throw Object.assign(new Error(result.detail), {
        statusCode: result.status ?? 0,
        ...(result.code ? { code: result.code } : {}),
        hint: result.hint,
        probe: result
      })
    }
    return result
  }
  const images = await generate({
    baseUrl: config.baseUrl,
    connectTimeoutMs: config.connectTimeoutMs,
    token,
    proxy,
    signal,
    ...payload
  })
  return images[0]
}

/**
 * The settings in force for one mode.
 *
 * A mode's override wins where it has one; everything else comes from the shared
 * defaults, so only the differences have to be stated. `??` rather than `||` on
 * purpose: a saved empty string is a real choice (an illustration with no default
 * negative is legitimate) and must not be read as "unset".
 *
 * @param config - the loaded configuration.
 * @param mode - `illustration` or `comic`.
 * @returns the effective settings.
 */
function settingsFor(config, mode) {
  // Per-mode overrides are retired: one shared set of defaults, always. Old
  // `config.modes` values are deliberately ignored rather than merged, so a
  // configuration saved while the floating window existed cannot keep changing
  // renders invisibly after the window is gone.
  return {
    mode,
    artistId: config.artistId,
    width: config.width,
    height: config.height,
    steps: config.steps,
    scale: config.scale,
    ucPreset: config.ucPreset,
    model: config.model,
    sampler: config.sampler,
    negativePrompt: config.negativePrompt,
    qualityToggle: config.qualityToggle,
    header: config.header,
    maxImagesPerCall: config.maxImagesPerCall,
    recipe: null
  }
}

/**
 * The artist string in force, if any.
 * @param config - the loaded configuration.
 * @returns the selected archive entry, or `null`.
 */
async function selectedArtist(config) {
  const id = Number(config.artistId)
  if (!Number.isInteger(id) || id < 0) return null
  // Through the merged view, so a saved edit or a user-created string applies.
  return artistById(await loadArtists(config), id)
}

/**
 * The artist string one render uses.
 *
 * @param stored - the selected archive entry, or `null`.
 * @param override - `undefined` keeps `stored`; `null` means no artist for this
 *   call; `{ positivePrompt, negativePrompt, name? }` replaces the text (and works
 *   without a stored selection — the workbench's 「临时画师串」).
 * @returns `{ name, positivePrompt, negativePrompt }` or `null`.
 */
function artistForCall(stored, override) {
  if (override === undefined) return stored
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return null
  const positivePrompt = String(override.positivePrompt ?? '').trim()
  const negativePrompt = String(override.negativePrompt ?? '').trim()
  if (positivePrompt === '' && negativePrompt === '') return null
  const name = String(override.name ?? '').trim() || stored?.name || '工作台临时画师串'
  return { ...(stored ?? {}), name, positivePrompt, negativePrompt }
}

/** Framing for a character reference picture: one figure, whole, on plain ground. */
const CHARACTER_PREVIEW_SUFFIX = 'solo, full body, standing, looking at viewer, simple background, white background'

/**
 * The default prompt of a character reference picture: the DNA's tags, the
 * chosen variant's tags, then the framing. A DNA written in prose keeps only its
 * tag part (`promptTags`); one with no tag part at all is sent as written.
 * @param character - the stored character.
 * @param variant - one of its `variableFeatures`, or `null`.
 * @returns the prompt, or `''` when the character has no features at all.
 */
function characterPreviewPrompt(character, variant) {
  const fixed = promptTags(character.fixedFeatures) || String(character.fixedFeatures ?? '').trim()
  const varied = variant === null ? '' : promptTags(variant.prompt) || String(variant.prompt ?? '').trim()
  if (fixed === '' && varied === '') return ''
  return [fixed, varied, CHARACTER_PREVIEW_SUFFIX].filter((part) => part !== '').join(', ')
}

/**
 * Find one character in the library by id, exact name, or a unique name/keyword
 * fragment — the lookup `nai_character_edit` uses. Throws with the list of
 * candidates when the query is ambiguous or matches nothing, because silently
 * editing the wrong character is worse than a clear failure.
 *
 * @param doc - the character document.
 * @param query - id, full name, or a fragment.
 * @returns the matching character.
 */
function findCharacterInDoc(doc, query) {
  const q = String(query ?? '').trim()
  const characters = Array.isArray(doc?.characters) ? doc.characters : []
  if (q === '') return null
  const byId = characters.find((row) => row.id === q)
  if (byId !== undefined) return byId
  const exact = characters.filter((row) => row.name === q)
  if (exact.length === 1) return exact[0]
  const lower = q.toLowerCase()
  const matches = characters.filter(
    (row) =>
      row.name.toLowerCase().includes(lower) ||
      (Array.isArray(row.keywords) ? row.keywords : []).some((keyword) => String(keyword).toLowerCase().includes(lower))
  )
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw Object.assign(new Error(`角色库里没有匹配「${q}」的角色。现有：${characters.map((row) => row.name).join('、') || '（空）'}`), { status: 404 })
  }
  throw Object.assign(new Error(`「${q}」匹配到多个角色：${matches.map((row) => row.name).join('、')}。请用完整名字或 id。`), { status: 400 })
}

/**
 * A per-call number, else the fallback.
 * @param value - the per-call value, possibly absent.
 * @param fallback - the configured default.
 * @returns a finite number.
 */
function optionalNumber(value, fallback) {
  if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))) return Number(value)
  return Number.isFinite(Number(fallback)) ? Number(fallback) : 0
}

/**
 * Run one render end to end against the live configuration.
 *
 * Several images are dispatched as **several single-image jobs** rather than one
 * job asking for `n_samples`: that is what lets the pool put them on different
 * keys at the same time, so four keys render four images concurrently instead of
 * one key rendering four in sequence.
 *
 * The selected artist string is prepended to the prompt and merged into the
 * negative, which is the whole point of keeping a style archive: pick a look
 * once, and every render carries it.
 *
 * @param options - prompt and optional per-call overrides.
 * @returns the written file records, the request and the pool's breadth.
 */
async function renderNow(options) {
  const config = await load()
  const outputDir = await outputDirOf(config)
  const sourceDir = await sourceDirOf(config)

  // 「替换角色关键词」: every keyword of an active character inside the prompt is
  // replaced by that character's fixed features before anything else happens —
  // in particular before the artist string is prefixed, so a keyword inside an
  // artist string is never expanded (nai-dbgen's order). Opt-in per call and
  // only on an explicit `true`.
  const replaceKeywords = options.replaceCharacterKeywords === true
  const replacedCharacters = []
  let captionInput = options.caption
  let promptInput = options.prompt
  if (replaceKeywords) {
    const doc = await loadCharacters()
    const swap = (text) => {
      const result = substituteKeywords(doc, String(text ?? ''))
      for (const name of result.replaced) if (!replacedCharacters.includes(name)) replacedCharacters.push(name)
      return result.text
    }
    if (captionInput !== null && typeof captionInput === 'object' && !Array.isArray(captionInput)) {
      captionInput = {
        ...captionInput,
        base: swap(captionInput.base),
        baseNegative: swap(captionInput.baseNegative),
        characters: (Array.isArray(captionInput.characters) ? captionInput.characters : []).map((row) => ({
          ...row,
          positive: swap(row?.positive),
          negative: swap(row?.negative)
        }))
      }
    } else {
      promptInput = swap(promptInput)
    }
  }

  // The workbench sends its prompt already structured (scene + characters); a
  // text prompt is parsed below. With a caption, the text form is derived from it.
  const structured = captionPage(captionInput)
  const submitted = structured === null ? String(promptInput ?? '').trim() : structured.prompt
  // What the user wrote, before keyword substitution and before the artist
  // string, header, quality tags and UC preset were added — so 「载入工作台」 can
  // reload a render without stacking a second artist string on top.
  const userPrompt = structured === null ? String(options.prompt ?? '').trim() : (captionPage(options.caption)?.prompt ?? submitted)
  if (!submitted) throw new Error('prompt is empty')

  // img2img / inpaint: read and validate the base image before any prompt
  // parsing, so a bad path fails fast instead of after the artist / UC / quality
  // pipeline has already run. `inlineImage` is the panel path: the browser has
  // already resized the base to the request size, so there is no file to read.
  const baseImage =
    options.inlineImage !== undefined
      ? options.inlineImage
      : options.sourceImage === undefined
        ? null
        : await readBaseImage({ root: sourceDir, filePath: options.sourceImage })
  // A mask turns the same pipeline into inpainting.
  const maskImage = options.inlineMask ?? null
  if (maskImage !== null && baseImage === null) throw new Error('局部重绘需要底图与蒙版')

  // A prompt may arrive as a structured page — see lib/format.js and lib/comic.js.
  // Parsing here rather than in each caller means the tool, the panel and the
  // transcript button all handle both formats identically, and a plain prompt is
  // untouched. The comic page is tried first because it carries an explicit
  // `format` marker, so recognising one never costs the 插画 path anything; the
  // mode setting can forbid it or force it.
  const mode = String(options.mode ?? config.mode ?? 'auto').toLowerCase()
  // The page is parsed first, because which format it turns out to be is what
  // decides which mode's settings apply.
  const sizeHint = { width: config.width, height: config.height }
  const comic = structured !== null || mode === 'illustration' ? null : maybeParseComicPage(submitted, sizeHint)
  const illustration = structured !== null ? structured : comic === null ? maybeParseImageBlock(submitted, sizeHint) : null
  const page = comic ?? illustration
  // `auto` gives each mode its own artist string, shape and negative without the
  // user having to switch anything: the input chooses.
  const effectiveMode = comic !== null ? 'comic' : 'illustration'
  const settings = settingsFor(config, effectiveMode)
  if (page === null && looksLikeAnyPage(submitted)) {
    // The text announces a page format but could not be read. Falling through
    // would send the JSON, the labels, the size header and the model's own
    // reasoning to NovelAI as literal prompt text — which renders as noise and
    // looks exactly like the plugin ignoring the format. Saying why is far more
    // useful than a silent bad render.
    const isComic = looksLikeComicPage(submitted)
    const attempt = isComic ? parseComicPage(submitted, sizeHint) : parseImageBlock(submitted, sizeHint)
    throw new Error(
      `这看起来是${isComic ? ' nai5-comic 漫画页' : ' <image> 块'}，但解析不了：${attempt.reason ?? '未知原因'}。` +
        `文本 ${submitted.length} 字符——` +
        (isComic
          ? '需要完整包含 "format":"nai5-comic"、"page":{"base":…} 以及 "panels":[…]（每格带 characters 数组）。'
          : '常见原因是块被截断了：需要完整包含 image###size:WxH 以及 Scene: / Char1: / Char1 UC: / Scene UC: 这些字段。')
    )
  }
  const prompt = page === null ? submitted : page.prompt

  const width = legalAxis(options.width ?? page?.width, settings.width)
  const height = legalAxis(options.height ?? page?.height, settings.height)
  // NovelAI rejects a mask whose size differs from the request, and the error is
  // not descriptive — say which two numbers disagree instead.
  if (
    maskImage !== null &&
    maskImage.width !== null &&
    maskImage.height !== null &&
    (maskImage.width !== width || maskImage.height !== height)
  ) {
    throw new Error(`蒙版尺寸 ${maskImage.width}×${maskImage.height} 必须与输出尺寸 ${width}×${height} 一致`)
  }
  const steps = Math.min(50, Math.max(1, Number(options.steps) || settings.steps))
  const nSamples = Math.min(settings.maxImagesPerCall, Math.max(1, Number(options.nSamples) || 1))
  const model = options.model || settings.model
  // 解析得比用到它的地方早：UC 预设正文要按模型族选取，而负向在下面几十行就要组装完。
  const ucPreset = Number.isFinite(Number(options.ucPreset)) ? Number(options.ucPreset) : config.ucPreset
  const sampler = options.sampler || settings.sampler
  const scale = Number.isFinite(Number(options.scale)) ? Number(options.scale) : settings.scale
  let negativePrompt = options.negativePrompt ?? settings.negativePrompt
  // The page's own negatives belong in the negative prompt, never the positive.
  if (page !== null && page.negativePrompt !== '') {
    negativePrompt = negativePrompt === '' ? page.negativePrompt : `${page.negativePrompt}, ${negativePrompt}`
  }

  // `artistId: -1` in the call overrides the setting, so one render can opt out.
  // Otherwise the mode's own artist string applies — a comic page and an
  // illustration rarely want the same style, and sharing one meant every comic
  // page silently carried the illustration's.
  const artistId = options.artistId === undefined ? Number(settings.artistId) : Number(options.artistId)
  const storedArtist = options.artistId === -1 ? null : await selectedArtist({ ...config, artistId })
  // The workbench edits the artist text per render without touching the stored
  // entry: `artistOverride` replaces the text for this call, `null` renders with
  // no artist at all, and an absent field keeps the stored one.
  const artist = artistForCall(storedArtist, options.artistOverride)
  const styleName = artist?.name ?? null
  const styledPrompt = artist === null || artist.positivePrompt.trim() === '' ? prompt : `${artist.positivePrompt}, ${prompt}`
  if (artist !== null && artist.negativePrompt !== '') {
    negativePrompt = negativePrompt === '' ? artist.negativePrompt : `${artist.negativePrompt}, ${negativePrompt}`
  }

  // UC 预设的正文由**客户端**拼进负向，服务端不看 `ucPreset` 字段
  // （证据与出处见 lib/uc-presets.js 的文件头）。
  //
  // 拼接细节以**参考插件**为准（官方文档只规定档位正文，不规定拼接方式）：
  // 预设正文前置到用户负向之前；用户负向为空时不追加。
  // 参考插件还会补 `nsfw, ` 前缀，本插件**刻意不做** —— 本 profile 跑成人内容，
  // 注入 NSFW 压制与用途冲突。详见 applyUcPreset 的注释。
  //
  // 幂等：若用户已把同一档正文手写进负向（本项目早期一直这么做），就不再叠加。
  // 用包含判断而非精确匹配——手写版本常缺尾部标签，精确比较几乎必然判不出重复。
  const ucText = ucPresetText(model, ucPreset)
  if (ucText !== '' && negativePrompt.includes(ucText)) {
    // 已在负向里手写过，保持原样。
  } else {
    negativePrompt = applyUcPreset(negativePrompt, model, ucPreset)
  }

  // The comic recipe adds how the page is *drawn* — greyscale or colour, pacing,
  // margin, bubbles — as opposed to what is in it, and only for the comic mode: an
  // illustration has no panels for a 分镜 to pace.
  //
  // **Prepended, not appended.** Style words carry the most weight at the front and
  // decay toward the tail, which is exactly why appending ~300 characters of recipe
  // after a ~470-character page left the page in full colour. It also goes into the
  // scene caption (below), because the caption is what describes the page as a whole
  // — a directive that only reached the legacy `prompt` field would miss the field
  // the API actually reads when characters are split out.
  const recipeFacts = effectiveMode === 'comic' ? recipeFragments(settings.recipe) : null
  const recipePositive = recipeFacts === null ? '' : recipeFacts.positive
  const finalPrompt = recipePositive === '' ? styledPrompt : `${recipePositive}, ${styledPrompt}`
  if (recipeFacts !== null && recipeFacts.negative !== '') {
    negativePrompt = negativePrompt === '' ? recipeFacts.negative : `${negativePrompt}, ${recipeFacts.negative}`
  }

  // 头部插入：放到**最前面**，连漫画配方也排在它后面。
  //
  // 位置是刻意的：NovelAI 的数据集切换标签（`fur dataset` 开 Furry Mode、
  // `background dataset`）官方要求位于提示词最开头，而画师串已占住第一位，
  // 所以只能由插件前置，且必须比别人更靠前。
  //
  // 计算时机在 `finalPrompt` 组装之后：header 必须排在配方与画师串之前，
  // 所以只能在两者都拼好之后再加一层前置。
  //
  // 注意多角色路径**不是**取自 finalPrompt —— `sceneCaption`（→ `v4_prompt.caption.base_caption`）
  // 是独立拼装的另一个数组，因此下面必须单独把 headerText 也放进去，否则
  // `<image>` 块的请求会丢掉头部，而普通提示词路径正常，形成只在多角色时才暴露的偏差。
  //
  // 空值/纯空白一律不加，也不留下多余的 ", " 前缀。
  const headerText = String(settings.header ?? '').trim()
  // 透明底 (V5): the official client puts `transparent background` at the front of
  // the prompt and sets two alpha flags (lib/nai.js). After the header, because a
  // dataset tag must stay first; skipped when the prompt already says it.
  const transparentOn =
    modelFamily(model) === 'v5' &&
    (options.transparentBackground === undefined ? config.transparentBackground === true : options.transparentBackground === true)
  const transparentText = transparentOn && !/\btransparent background\b/i.test(finalPrompt) ? 'transparent background' : ''
  const headedPrompt = [headerText, transparentText, finalPrompt].filter((text) => text !== '').join(', ')

  // 官方质量词：**追加到末尾**，与官方桌面端 `[prompt, quality].join(', ')` 一致。
  //
  // 默认关（`settings.qualityToggle` 缺省 false）。开启的代价要清楚：画师串里常自带
  // `masterpiece, best quality, very aesthetic`，叠加会重复，所以这里**不去重** ——
  // 去重会改写用户画师串的语义，那是更坏的选择。正文见 lib/quality-tags.js。
  //
  // 位置在 header 与配方之后：它们都要求靠前占权重，质量词是收尾微调。
  // 按次覆盖：`options.qualityToggle` 优先，其次模式有效值。若只读 settings，
  // nai_generate 的 `quality_toggle` 参数就会被静默忽略 —— 与 ucPreset 同一个坑。
  const qualityOn = options.qualityToggle === undefined ? settings.qualityToggle === true : options.qualityToggle === true
  const qualityText = qualityTagText(qualityOn)
  const promptedText = qualityText === '' ? headedPrompt : `${headedPrompt}, ${qualityText}`

  const activePool = poolFor(config)
  if (!activePool.configured()) {
    throw new Error('没有可用的 NovelAI API Key。侧栏面板里添加，或导出 NAI_TOKEN。')
  }

  const job = {
    prompt: promptedText,
    negativePrompt,
    model,
    width,
    height,
    steps,
    scale,
    sampler,
    // A block's characters travel as their own captions with their own grid
    // positions — the only way `CharN UC` can apply to one character rather than
    // to the whole picture. Plain prompts send an empty list and keep the
    // single-caption path they have always used.
    characters:
      page === null
        ? []
        : page.characters.map((row) => ({ positive: row.text, negative: row.negative, centers: row.centers })),
    sceneCaption:
      page === null
        ? null
        : [headerText, transparentText, recipePositive, artist === null ? '' : artist.positivePrompt, page.sceneCaption, qualityText]
            .filter((text) => String(text).trim() !== '')
            .join(', '),
    sceneNegative:
      page === null
        ? null
        : [
            // 复用上面已组装好的负向（其中已含 UC 预设正文与画师串负向），
            // 而不是从 options/config 重新拼一遍 —— 后者会漏掉预设正文，
            // 且原本连 page.negativePrompt 都没带，使 `<image>` 块与普通提示词
            // 在同一档位下得到不同的负向。
            negativePrompt,
            page.sceneNegative
          ]
            .filter((text) => String(text ?? '').trim() !== '')
            .join(', '),
    ucPreset,
    nSamples: 1,
    seed: options.seed,
    // Sampling knobs: per call first, then the configured default. The schedule
    // is recorded as sent (V5 forces karras), variety as asked — buildPayload
    // drops it for models other than 4.5.
    cfgRescale: optionalNumber(options.cfgRescale, config.cfgRescale),
    noiseSchedule: noiseScheduleFor(model, options.noiseSchedule ?? config.noiseSchedule),
    variety: options.variety === undefined || options.variety === null ? config.variety === true : options.variety === true,
    transparent: transparentOn,
    smea: String(options.smea ?? config.smea ?? 'off'),
    // zip (smallest transfer) / json (nai-dbgen-style relay) / auto, from the
    // plugin's 「解码」 setting; generate() turns it into the Accept header.
    accept: acceptForDecode(config.decode),
    // Carried through the pool to `generate` so the panel can show how many
    // bytes of the PNG have arrived. Not part of the request body, and stripped
    // from the sidecar below.
    ...(typeof options.onProgress === 'function' ? { onProgress: options.onProgress } : {}),
    // Only img2img/infill carry a base image; txt2img keeps the exact request
    // body it always sent (buildPayload defaults action to 'generate').
    ...(baseImage === null
      ? {}
      : maskImage === null
        ? { action: 'img2img', image: baseImage.base64, strength: options.strength, noise: options.noise }
        : {
            action: 'infill',
            image: baseImage.base64,
            mask: maskImage.base64,
            addOriginalImage: options.addOriginalImage,
            inpaintStrength: options.inpaintStrength
          })
  }
  // What the debug log records about this render, filled in before the request so
  // a failure is logged with the same facts as a success (see renderLogged).
  if (options.trace !== null && typeof options.trace === 'object') {
    Object.assign(options.trace, {
      model,
      width,
      height,
      steps,
      nSamples,
      characters: page === null ? 0 : page.characters.length,
      artistId: storedArtist === null && artist === null ? -1 : artistId,
      artistName: styleName,
      seed: options.seed ?? null,
      prompt: promptedText
    })
  }
  // `signal` cancels the render: a queued job leaves the queue, a running one has
  // its NovelAI request torn down (the panel closing, or 取消出图).
  const images = await Promise.all(Array.from({ length: nSamples }, () => activePool.enqueue({ ...job }, { signal: options.signal })))
  // Never persist the base64 payloads: the sidecar is a reproducibility record,
  // and a 1.7 MB PNG becomes ~2.3 MB of base64 per job.
  const { image: _base64, mask: _mask, onProgress: _onProgress, ...recordable } = job
  const request = {
    ...recordable,
    nSamples,
    artist: styleName,
    // Enough to load the render back into the workbench: the text as written,
    // the structured caption (before substitution), the toggle, and the artist.
    userPrompt,
    ...(structured === null ? {} : { caption: options.caption }),
    replaceCharacterKeywords: replaceKeywords,
    ...(replacedCharacters.length > 0 ? { replacedCharacters } : {}),
    artistId: storedArtist === null ? -1 : artistId,
    ...(options.artistOverride === undefined ? {} : { artistOverride: options.artistOverride }),
    ...(baseImage === null
      ? {}
      : {
          source: {
            name: baseImage.name,
            mime: baseImage.mime,
            width: baseImage.width,
            height: baseImage.height,
            bytes: baseImage.bytes
          }
        }),
    ...(maskImage === null
      ? {}
      : {
          mask: {
            name: maskImage.name,
            width: maskImage.width,
            height: maskImage.height,
            bytes: maskImage.bytes
          }
        })
  }
  const files = await persist({ outputDir, images, request })
  await enforceKeepImages(config, outputDir)
  return {
    files,
    request,
    source:
      baseImage === null
        ? null
        : {
            name: baseImage.name,
            mime: baseImage.mime,
            width: baseImage.width,
            height: baseImage.height,
            bytes: baseImage.bytes
          },
    mask:
      maskImage === null
        ? null
        : {
            name: maskImage.name,
            width: maskImage.width,
            height: maskImage.height,
            bytes: maskImage.bytes
          },
    weight: costWeight({ width, height, steps, nSamples }),
    concurrency: activePool.concurrency,
    artist: styleName,
    /** Characters whose keywords were replaced by their fixed features. */
    replacedCharacters,
    // How much of the final prompt the style prefix actually occupies. An artist
    // string is 400–1200 characters of style tags, which is comparable to a whole
    // scene description — enough to visibly override what was asked for, and
    // invisible unless it is reported.
    artistWeight:
      artist === null
        ? null
        : {
            name: styleName,
            positiveChars: artist.positivePrompt.length,
            negativeChars: artist.negativePrompt.length,
            shareOfPositive: styledPrompt.length === 0 ? 0 : Math.round(((artist.positivePrompt.length + 2) / styledPrompt.length) * 100)
          },
    // Surfaced so the tool can report how a page was read and what it noticed.
    block:
      page === null
        ? null
        : {
            format: page.format ?? 'image-block',
            characters: page.characters,
            notes: page.notes,
            sizeSource: page.sizeSource,
            panelCount: page.panelCount ?? null,
            positionMode: page.positionMode ?? null,
            positiveChars: page.prompt.length,
            negativeChars: page.negativePrompt.length
          }
  }
}

/**
 * Run the live capability check against the current configuration.
 *
 * Everything this plugin has ever broken, broke silently: a coerced type, a
 * stripped id, a dropped branch, a module not yet loaded. This is the counter-
 * measure — one call that exercises each capability and reports it, so a restart
 * can be confirmed instead of hoped about. Renders nothing, costs nothing.
 *
 * @returns `{ ok, checks }`.
 */
async function doctorReport() {
  const config = await load()
  return await runDoctor({
    config,
    pool: poolFor(config),
    proxy: proxyFor(config),
    loadIndex,
    // The merged view (archive + the user's edits and own strings): the
    // remembered selection may well be a 「我的画师串」 id.
    loadArtists,
    artistById,
    coverFileOf,
    searchArtists,
    readArtistImage,
    listLibraries,
    lookup,
    resolveCharacter,
    digest,
    clientSource: await readFile(new URL('./client.js', import.meta.url), 'utf8').catch(() => ''),
    outputDir: await outputDirOf(config),
    packageRoot: import.meta.dirname,
    modeSettings: MODE_NAMES.map((name) => settingsFor(config, name))
  })
}

// ------------------------------------------------------------- dsh-go native --
/**
 * Last snapshot built for the DSH Go panel and status strip. The strip and the
 * tap handlers read it, so a tap never waits for an I/O round trip.
 */
let dshGoCache = { data: null, at: 0 }

/**
 * The data the DSH Go panel's bindings read and the status strip summarises.
 *
 * Everything here is local — config, the pool's last subscription record, the
 * character library and the output directory — except `refresh: true`, which
 * does one free subscription probe. That split is what keeps the strip free of
 * network calls while still showing a balance that any probe or panel refresh
 * has already fetched.
 *
 * @param options - `{ refresh?: boolean, locale?: string }`.
 * @returns the data object pushed to the app (also cached in `dshGoCache`).
 */
async function buildDshGoData(options = {}) {
  const config = await load()
  const pool = poolFor(config)
  const health = pool.healthSummary()
  let balance = null
  let error = ''
  for (const key of pool.list()) {
    const sub = key.subscription
    if (sub === null || sub === undefined) continue
    const anlas = sub.anlas ?? null
    if (anlas === null || !Number.isFinite(Number(anlas.total))) continue
    balance = {
      total: Number(anlas.total),
      fixed: Number(anlas.fixed ?? 0),
      purchased: Number(anlas.purchased ?? 0),
      energy: sub.energy?.percent ?? null,
      unavailable: sub.energy?.unavailable === true
    }
    break
  }
  if (options.refresh === true) {
    try {
      const result = await probeNow({})
      if (result?.ok === true && result.subscription?.anlas) {
        const sub = result.subscription
        balance = {
          total: Number(sub.anlas.total ?? 0),
          fixed: Number(sub.anlas.fixed ?? 0),
          purchased: Number(sub.anlas.purchased ?? 0),
          energy: sub.energy?.percent ?? null,
          unavailable: sub.energy?.unavailable === true
        }
      } else if (result?.ok === false) {
        error = String(result.detail ?? '连接检测失败')
      }
    } catch (failure) {
      error = String(failure?.message ?? failure)
    }
  }
  const en = String(options.locale ?? 'zh').toLowerCase().startsWith('en')
  const outputDir = await outputDirOf(config)
  const [shots, doc, artists] = await Promise.all([gallery(outputDir, 30), loadCharacters(), loadArtists(config)])
  const groupNames = new Map(doc.groups.map((group) => [group.id, group.name]))
  const characters = doc.characters.slice(0, 20).map((row) => ({
    id: row.id,
    name: row.name,
    group: groupNames.get(row.groupId) ?? '',
    keywords: row.keywords,
    insertText: `${(row.keywords.length > 0 ? row.keywords : [row.name]).join(', ')}, `
  }))
  const recent = shots.slice(0, 10).map((row) => ({
    name: row.name,
    bytes: row.bytes,
    when: new Date(row.mtime).toISOString().slice(5, 16).replace('T', ' '),
    path: join(outputDir, row.name)
  }))
  const artist = config.artistId >= 0 ? artistById(artists, config.artistId) : null
  const cachedAt = options.refresh === true ? Date.now() : dshGoCache.at
  const data = {
    model: String(config.model ?? '—'),
    size: `${config.width}×${config.height}`,
    sampler: String(config.sampler ?? '—'),
    steps: Number(config.steps ?? 0),
    artistText: artist === null ? (en ? 'off' : '不使用') : `${artist.name} · #${artist.sequence}`,
    checkedText: cachedAt === 0 ? (en ? 'not checked' : '未检测') : new Date(cachedAt).toLocaleTimeString(),
    error,
    keys: health,
    balance:
      balance === null
        ? null
        : {
            totalText: balance.total.toLocaleString('en-US'),
            breakdown: `${balance.fixed.toLocaleString('en-US')} + ${balance.purchased.toLocaleString('en-US')}`,
            energyText: balance.unavailable ? (en ? 'n/a' : '不可用') : balance.energy === null ? '—' : `${balance.energy}%`,
            tone: balance.energy === null ? 'info' : balance.energy >= 50 ? 'good' : balance.energy >= 10 ? 'warn' : 'bad'
          },
    ...listItems(characters, recent),
    characters,
    recent
  }
  dshGoCache = { data, at: cachedAt }
  return data
}

/**
 * Mount the tools and the HTTP API.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  // ---------------------------------------------------------------- tools --
  ctx.tools.register(
    defineTool({
      name: 'nai_generate',
      description:
        'Render an image with NovelAI. The PNG is written to the configured output directory and every written path is returned, so you can embed it in your reply as Markdown (`![描述](绝对路径)`) and it appears inline in the conversation. ' +
        'The prompt is either Danbooru-style tags — weights use `N::tag::` — a whole `<image>` block in the 「文生图」 format, or a whole `nai5-comic` page (one JSON object per comic page), each accepted verbatim. ' +
        'For an `<image>` block the `<image_think>` reasoning is dropped and the `Scene:`/`CharN:`/`UC:` fields are split. For a `nai5-comic` page the panels become the scene, each character appearance gets its own caption and negative, and `center` becomes a real position. ' +
        '`n_samples` renders several variants of one prompt, dispatched in parallel across the configured API keys.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description:
            'The positive prompt as Danbooru tags (`N::tag::` weights allowed), or a complete `<image>…</image>` block in the 「文生图」 format, which is parsed for you.'
        },
        negative_prompt: { type: 'string', description: 'Undesired-content prompt. Defaults to the configured one.' },
        width: { type: 'integer', description: 'Pixels; snapped to a multiple of 64. Defaults to the configured width.' },
        height: { type: 'integer', description: 'Pixels; snapped to a multiple of 64. Defaults to the configured height.' },
        model: { type: 'string', description: 'NovelAI model id, e.g. nai-diffusion-4-5-full. Defaults to the configured model.' },
        steps: { type: 'integer', description: 'Sampling steps, 1..50. Defaults to the configured value.' },
        scale: { type: 'number', description: 'Prompt guidance (CFG). Defaults to the configured value.' },
        sampler: { type: 'string', description: 'Sampler id, e.g. k_euler_ancestral. Defaults to the configured value.' },
        seed: { type: 'integer', description: 'Pin the seed for a reproducible render. Omit to let NovelAI choose.' },
        n_samples: { type: 'integer', description: 'Number of variants, 1..maxImagesPerCall. Variants are dispatched in parallel, one per usable API key.' },
        artist_id: {
          type: 'integer',
          description: 'Artist string to prepend, by archive id (see nai_artists). Pass -1 to render without the configured style for this one call.'
        },
        mode: {
          type: 'string',
          description:
            'auto | illustration | comic. `auto` (default) lets the input choose: a nai5-comic page uses the comic settings and its recipe, anything else the illustration settings. `illustration` refuses a comic page; `comic` reads one first.'
        },
        uc_preset: {
          type: 'integer',
          description:
            'Undesired-content preset for this call, overriding the configured one. 0=heavy, 1=light, 2=furryFocus, 3=humanFocus (default), 4=none. The preset text is prepended to the negative prompt by this client, as the official one does.'
        },
        quality_toggle: {
          type: 'boolean',
          description:
            'Append the official quality tags to the end of the positive prompt for this call. Off by default.'
        }
      },
      output: {
        schema: { type: 'object' },
        render: textRender((value) => (typeof value === 'string' ? value : (value?.text ?? ''))),
        presentationMeta: toolCard((_args, value) => generateView(value))
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const { files, request, weight, concurrency, artist, block, artistWeight, logId } = await renderLogged('tool:generate', {
          prompt: args.prompt,
          negativePrompt: args.negative_prompt,
          width: args.width,
          height: args.height,
          model: args.model,
          steps: args.steps,
          scale: args.scale,
          sampler: args.sampler,
          seed: args.seed,
          nSamples: args.n_samples,
          artistId: args.artist_id,
          mode: args.mode,
          // Without this the render silently fell back to `config.ucPreset`, so
          // `uc_preset: 2` looked accepted but never reached the request. The
          // parameter was absent from this tool's schema entirely.
          ucPreset: args.uc_preset,
          qualityToggle: args.quality_toggle
        })
        const lines = files.map((file, index) => {
          const bits = [`${file.bytes} 字节`]
          if (file.seed !== null) bits.push(`seed ${file.seed}`)
          if (file.model) bits.push(file.model)
          if (file.steps !== null) bits.push(`${file.steps} 步`)
          return `${index + 1}. ${file.file}\n   ${bits.join(' · ')}`
        })
        const header = [
          `已渲染 ${files.length} 张 · ${request.width}×${request.height} · ${request.steps} 步 · ${request.model} · 并发 ${concurrency} · 相对消耗 ${weight}`,
          artist === null
            ? ''
            : `画师串「${artist}」+${artistWeight.positiveChars} 字符（占正向 ${artistWeight.shareOfPositive}%）`
        ]
          .filter(Boolean)
          .join(' · ')
        const text = [
          header,
          // An artist string is a style prefix the size of a whole scene, so say
          // so loudly when it dominates. Otherwise the render quietly comes back
          // looking nothing like the prompt and the plugin gets the blame.
          ...(artistWeight === null || artistWeight.shareOfPositive < 25
            ? []
            : [
                `⚠ 画师串占了正向的 ${artistWeight.shareOfPositive}%（${artistWeight.positiveChars} / ${request.prompt.length} 字符），` +
                  `负向也并入了 ${artistWeight.negativeChars} 字符。它会明显压过你写的提示词。` +
                  '要严格按提示词出图：本次调用传 artist_id: -1，或先在侧栏把画师串关掉。'
              ]),
          // When the prompt was an `<image>` block, say how it was read: the
          // structural parts are invisible from the outside, and a note about a
          // size that came from an orientation word is worth knowing.
          ...(block === null
            ? []
            : [
                (block.format === 'nai5-comic'
                  ? `漫画页：${block.panelCount} 格 · 正向 ${block.positiveChars} 字符 · 负向 ${block.negativeChars} 字符 · 定位 ${block.positionMode}`
                  : `<image> 块：正向 ${block.positiveChars} 字符 · 负向 ${block.negativeChars} 字符 · 尺寸来源 ${block.sizeSource}`) +
                  (block.characters.length > 0
                    ? ` · 角色 ${block.characters.map((c) => `${c.label}${(c.centers ?? []).length === 0 ? '' : `@${JSON.stringify(c.centers[0])}`}`).join(' ')}`
                    : ''),
                ...block.notes.map((note) => `  · ${note}`)
              ]),
          '',
          ...lines,
          '',
          '在回复里内联显示：',
          files.map((file) => `![生成图片](${file.file})`).join('\n')
        ].join('\n')
        // The model reads `text`; the phone draws `presentationMeta` from the
        // structured fields. Both come from the same render record.
        return { text, files, request, weight, concurrency, artist, artistWeight, block, logId }
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_img2img',
      description:
        'Rework a local image with NovelAI image-to-image. The base image must sit in the plugin source directory (see nai_status 输入目录; default <workspace>/_in/nai) and must be PNG/JPEG/WebP — its bytes are read here and never leave the machine except to NovelAI. ' +
        'width and height are required: the output canvas is never inferred from the base image, so pass the size you want to render at. ' +
        'strength (0.01–0.99) is how far the result may drift from the base; 0.5 is NovelAI\'s suggested start, low values stay close, high values approach a fresh text-to-image. noise (0–0.99) adds variation on top. ' +
        'The prompt goes through the same artist-string / UC-preset / quality-tag pipeline as nai_generate, and the rendered PNG is written to the output directory with its path returned for inline Markdown.',
      parameters: {
        source_image: {
          type: 'string',
          required: true,
          description:
            'Base image file name inside the source directory, or a path inside it. PNG/JPEG (verified against NovelAI) or WebP (accepted locally but untested upstream), ≤24MB, and ≤3,047,424 px in total — NovelAI answers a larger image with a bare 500. Anything outside that directory is refused.'
        },
        prompt: { type: 'string', required: true, description: 'Positive prompt as Danbooru tags (`N::tag::` weights allowed).' },
        width: {
          type: 'integer',
          required: true,
          description: 'Output canvas width in pixels; snapped to a multiple of 64. Required — never inferred from the base image.'
        },
        height: {
          type: 'integer',
          required: true,
          description: 'Output canvas height in pixels; snapped to a multiple of 64. Required — never inferred from the base image.'
        },
        strength: { type: 'number', description: 'How far the result may drift from the base image, 0.01–0.99. Defaults to 0.5.' },
        noise: { type: 'number', description: 'Extra variation added on top of the base image, 0–0.99. Defaults to 0.' },
        negative_prompt: { type: 'string', description: 'Undesired-content prompt. Defaults to the configured one.' },
        model: { type: 'string', description: 'NovelAI model id. Use a normal (non-inpainting) model for img2img. Defaults to the configured model.' },
        steps: { type: 'integer', description: 'Sampling steps, 1..50. Defaults to the configured value.' },
        scale: { type: 'number', description: 'Prompt guidance (CFG). Defaults to the configured value.' },
        sampler: { type: 'string', description: 'Sampler id, e.g. k_euler_ancestral. Defaults to the configured value.' },
        seed: { type: 'integer', description: 'Pin the seed for a reproducible render.' },
        n_samples: { type: 'integer', description: 'Variants, 1..maxImagesPerCall. Each variant is a separate request and leaves the Opus free band.' },
        uc_preset: { type: 'integer', description: 'Undesired-content preset override: 0=heavy, 1=light, 2=furryFocus, 3=humanFocus, 4=none.' },
        quality_toggle: { type: 'boolean', description: 'Append the official quality tags for this call.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        if (args.width === undefined || args.height === undefined) {
          throw new Error('nai_img2img 必须显式指定 width 与 height（不跟随底图尺寸）。')
        }
        // Clamp here, not only in buildPayload: `request` is what the tool
        // reports back and what the sidecar records, and it must state the value
        // that was actually sent rather than the one the caller typed.
        const strength = Math.min(0.99, Math.max(0.01, Number(args.strength ?? 0.5)))
        const noise = Math.min(0.99, Math.max(0, Number(args.noise ?? 0)))
        const result = await renderLogged('tool:img2img', {
          prompt: args.prompt,
          negativePrompt: args.negative_prompt,
          width: args.width,
          height: args.height,
          model: args.model,
          steps: args.steps,
          scale: args.scale,
          sampler: args.sampler,
          seed: args.seed,
          nSamples: args.n_samples,
          ucPreset: args.uc_preset,
          qualityToggle: args.quality_toggle,
          sourceImage: args.source_image,
          strength,
          noise
        })
        const { files, request, weight, concurrency, source } = result
        const free = insideFreeBand({
          width: request.width,
          height: request.height,
          steps: request.steps,
          nSamples: files.length
        })
        const header = [
          `图生图完成 ${files.length} 张 · ${request.width}×${request.height} · ${request.steps} 步 · ${request.model} · strength ${request.strength} · noise ${request.noise} · 并发 ${concurrency} · 相对消耗 ${weight}`,
          source === null
            ? ''
            : `底图：${source.name}（${source.width ?? '尺寸未知'}×${source.height ?? '尺寸未知'}，${source.mime}，${(source.bytes / 1024).toFixed(0)}KB）`
        ]
          .filter((line) => line !== '')
          .join('\n')
        const lines = files.map((file, index) => {
          const bits = [`${file.bytes} 字节`]
          if (file.seed !== null) bits.push(`seed ${file.seed}`)
          if (file.model) bits.push(file.model)
          return `${index + 1}. ${file.file}\n   ${bits.join(' · ')}`
        })
        return [
          header,
          free
            ? `免费区间：像素积 ${request.width * request.height} ≤ ${FREE_AREA.toLocaleString('en-US')}、${request.steps} 步 ≤ 28、单张 —— 预期 0 Anlas（底图像素不参与该判定；V5 模型仍会消耗 Opus 用量电池）。`
            : '超出 Opus 免费区间（要求像素积 ≤ 1,048,576、步数 ≤ 28、单张）—— 超出的部分会消耗 Anlas；i2i 的实际扣费按 strength 折算。',
          '',
          ...lines,
          '',
          '在回复里内联显示：',
          files.map((file) => `![生成图片](${file.file})`).join('\n')
        ].join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_inpaint',
      description:
        'Redraw one region of an image with NovelAI inpainting. The base image and the mask both live in the source directory (see nai_status 输入目录). ' +
        'The mask is a PNG of exactly the output width×height whose non-transparent pixels mark the area to regenerate; the rest is kept from the base image. ' +
        'An inpainting model is required — the `-inpainting` suffix is appended to the configured or requested model automatically. ' +
        'width and height are required and decide the canvas the mask must match; the prompt reuses the same artist/UC/quality pipeline as nai_generate.',
      parameters: {
        source_image: { type: 'string', required: true, description: 'Base image file inside the source directory (PNG/JPEG/WebP).' },
        mask_image: {
          type: 'string',
          required: true,
          description: 'Mask PNG inside the source directory, same width×height as the request; non-transparent pixels are repainted.'
        },
        prompt: { type: 'string', required: true, description: 'Prompt for the repainted region.' },
        width: { type: 'integer', required: true, description: 'Output canvas width; must equal the mask width; snapped to a multiple of 64.' },
        height: { type: 'integer', required: true, description: 'Output canvas height; must equal the mask height; snapped to a multiple of 64.' },
        model: {
          type: 'string',
          description: 'Base model id; the -inpainting suffix is appended automatically. Defaults to the configured model.'
        },
        inpaint_strength: { type: 'number', description: 'How far the repainted region may drift, 0–1. Defaults to 1.' },
        add_original_image: {
          type: 'boolean',
          description: 'Keep pixels outside the mask from the base image. Default true.'
        },
        negative_prompt: { type: 'string', description: 'Undesired-content prompt. Defaults to the configured one.' },
        steps: { type: 'integer', description: 'Sampling steps, 1..50. Defaults to the configured value.' },
        scale: { type: 'number', description: 'Prompt guidance (CFG). Defaults to the configured value.' },
        sampler: { type: 'string', description: 'Sampler id. Defaults to the configured value.' },
        seed: { type: 'integer', description: 'Pin the seed for a reproducible render.' },
        n_samples: { type: 'integer', description: 'Variants, 1..maxImagesPerCall.' },
        uc_preset: { type: 'integer', description: 'Undesired-content preset override: 0=heavy … 4=none.' },
        quality_toggle: { type: 'boolean', description: 'Append the official quality tags for this call.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const sourceDir = await sourceDirOf(config)
        const image = await readBaseImage({ root: sourceDir, filePath: args.source_image })
        const mask = await readBaseImage({ root: sourceDir, filePath: args.mask_image })
        if (mask.mime !== 'image/png') throw new Error('mask_image 必须是 PNG（alpha 通道标记重绘区）')
        const strength = Math.min(1, Math.max(0, Number(args.inpaint_strength ?? 1)))
        const result = await renderLogged('tool:inpaint', {
          prompt: args.prompt,
          negativePrompt: args.negative_prompt,
          width: args.width,
          height: args.height,
          model: inpaintModelOf(args.model ?? config.model),
          steps: args.steps,
          scale: args.scale,
          sampler: args.sampler,
          seed: args.seed,
          nSamples: args.n_samples,
          ucPreset: args.uc_preset,
          qualityToggle: args.quality_toggle,
          inlineImage: image,
          inlineMask: mask,
          addOriginalImage: args.add_original_image !== false,
          inpaintStrength: strength
        })
        const request = result.request
        const free = insideFreeBand({
          width: request.width,
          height: request.height,
          steps: request.steps,
          nSamples: result.files.length
        })
        return [
          `局部重绘完成 ${result.files.length} 张 · ${request.width}×${request.height} · ${request.steps} 步 · ${request.model} · 重绘强度 ${strength} · 并发 ${result.concurrency} · 相对消耗 ${result.weight}`,
          `底图：${image.name}（${image.width ?? '?'}×${image.height ?? '?'}）　蒙版：${mask.name}（${mask.width}×${mask.height}）`,
          free
            ? `免费区间：像素积 ${request.width * request.height} ≤ ${FREE_AREA}、${request.steps} 步 ≤ 28、单张 —— 预期 0 Anlas。`
            : '超出 Opus 免费区间 —— 会消耗 Anlas。',
          '',
          ...result.files.map(
            (file, index) =>
              `${index + 1}. ${file.file}\n   ${file.bytes} 字节${file.seed !== null ? ` · seed ${file.seed}` : ''}${file.model ? ` · ${file.model}` : ''}`
          ),
          '',
          '在回复里内联显示：',
          result.files.map((file) => `![生成图片](${file.file})`).join('\n')
        ].join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_director',
      description:
        'Post-process one image with NovelAI Director Tools. The five free tools are available: lineart (线稿提取), sketch (草图), colorize (上色), emotion (表情微调) and declutter (画面杂物消除). ' +
        'The input is read from the output gallery by default (`from: gallery`) or from the img2img source directory (`from: source`). ' +
        'The result is written to the output directory and its path returned, so it can be embedded inline with Markdown. These tools spend no Anlas.',
      parameters: {
        image: { type: 'string', required: true, description: 'File name inside the gallery, or inside the source directory when from="source".' },
        tool: {
          type: 'string',
          required: true,
          enum: DIRECTOR_TYPES,
          description: 'lineart | sketch | colorize | emotion | declutter'
        },
        from: { type: 'string', enum: ['gallery', 'source'], description: 'Where to read the image from. Defaults to gallery.' },
        emotion: { type: 'string', description: 'Emotion for tool="emotion", e.g. "happy", "sad", "angry".' },
        prompt: { type: 'string', description: 'Optional prompt, for tools that accept one (colorize).' },
        defry: { type: 'integer', description: 'Defry level 0–5 (colorize/emotion).' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const files = await runDirectorTool({
          from: args.from === 'source' ? 'source' : 'gallery',
          name: String(args.image ?? ''),
          type: String(args.tool ?? ''),
          prompt: args.prompt === undefined ? null : String(args.prompt),
          emotion: args.emotion === undefined ? null : String(args.emotion),
          defry: args.defry === undefined ? null : Number(args.defry),
          signal: exec.signal
        })
        const file = files[0]
        return [
          `导演工具完成：${args.tool} · ${String(args.image ?? '')} → ${file.bytes} 字节`,
          '',
          '在回复里内联显示：',
          `![生成图片](${file.file})`
        ].join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_estimate',
      description:
        'Estimate what one render would cost before spending it, and see which parameters are driving the cost. ' +
        'The number is a relative weight (area x steps x variants, with 832x1216 at 28 steps defined as 1), not a price: a NovelAI Opus subscription bills nothing inside the standard size envelope and bills above it. ' +
        'Call this before a large or repeated render.',
      parameters: {
        width: { type: 'integer', description: 'Pixels; snapped to a multiple of 64. Defaults to the configured width.' },
        height: { type: 'integer', description: 'Pixels; snapped to a multiple of 64. Defaults to the configured height.' },
        steps: { type: 'integer', description: 'Sampling steps. Defaults to the configured value.' },
        n_samples: { type: 'integer', description: 'Variants. Defaults to 1.' }
      },
      output: {
        schema: { type: 'object' },
        render: textRender((value) => (typeof value === 'string' ? value : (value?.text ?? ''))),
        presentationMeta: toolCard((_args, value) => estimateView(value))
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const width = legalAxis(args.width, config.width)
        const height = legalAxis(args.height, config.height)
        const steps = Math.min(50, Math.max(1, Number(args.steps) || config.steps))
        const nSamples = Math.max(1, Number(args.n_samples) || 1)
        const capped = Math.min(nSamples, config.maxImagesPerCall)
        const weight = costWeight({ width, height, steps, nSamples: capped })
        const perImage = costWeight({ width, height, steps, nSamples: 1 })
        const free = insideFreeBand({ width, height, steps, nSamples: capped })
        const text = [
          `参数：${width}×${height} · ${steps} 步 · ${capped} 张`,
          `单张相对消耗：${perImage}   合计：${weight}`,
          `（参照：832×1216 @28 步 = 1）`,
          free
            ? `落在 Opus 免计费区间内（单张、像素积 ≤ ${FREE_AREA.toLocaleString('en-US')}、≤28 步）—— 应当不消耗 Anlas。底图像素不计入该判定。`
            : `超出 Opus 免计费区间（要求单张、像素积 ≤ ${FREE_AREA.toLocaleString('en-US')}、≤28 步）—— 超出的部分会消耗 Anlas。`,
          capped < nSamples ? `注意：请求的 ${nSamples} 张被 maxImagesPerCall 压到 ${capped} 张。` : '',
          capped > 1 ? '多张（n_samples > 1）本身就会离开免计费区间。' : ''
        ]
          .filter((line) => line !== '')
          .join('\n')
        return { text, width, height, steps, nSamples: capped, weight, perImage, free }
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_lookup',
      description:
        'Search the five 附体 libraries (标签库9.5 / 常规模板5.25 / 扩展库5.4 / 同人库8.5 / SEX模板9.2) by keyword against titles, trigger keys and bodies. ' +
        'Use this before writing a prompt: 标签库 is the Chinese-to-Danbooru dictionary, 常规模板 is clothing and character transformations, 扩展库 is monster-girl DNA templates with forbidden actions and UC exclusions, 同人库 is the character roster, SEX模板 is verified scene prompt combinations. ' +
        'Inside a returned body, `a/b/c` means pick one, `a,b,c` means the tags belong together, and bracketed placeholders like `[x]` must be replaced — `[tag]` is a down-weight in NAI, never literal text.',
      parameters: {
        query: { type: 'string', required: true, description: 'Keyword. A bare `.` returns entries in order, for paging a whole library.' },
        library: { type: 'string', description: `Restrict to one library. One of: ${LIBRARIES.join(' / ')}` },
        limit: { type: 'integer', description: 'Maximum hits, default 8.' },
        full: { type: 'boolean', description: 'Return full bodies instead of truncating long ones.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        return digest(
          await lookup(args.query, {
            libraryDir: config.libraryDir,
            library: args.library,
            limit: Math.min(20, Math.max(1, Number(args.limit) || 8)),
            full: args.full === true
          })
        )
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_resolve',
      description:
        'Resolve a character to their entry in the 同人库8.5 roster: official Danbooru tag plus appearance and outfit anchors. ' +
        'Always resolve before inventing a tag — the roster is authoritative and a guessed tag silently renders a stranger.',
      parameters: {
        name: { type: 'string', required: true, description: 'Chinese name, romanisation, or tag fragment.' },
        limit: { type: 'integer', description: 'Maximum hits, default 3.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const result = await resolveCharacter(args.name, {
          libraryDir: config.libraryDir,
          limit: Math.min(10, Math.max(1, Number(args.limit) || 3))
        })
        return digest({ ...result, total: result.hits.length })
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_index',
      description:
        'Rebuild the five-library search index from the original world-book JSONs. Run once after install, or after adding or updating a library file. ' +
        'When several historical releases of the same library sit in the source directory, the release with the most entries wins.',
      parameters: {},
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        const result = await rebuildIndex({ sourceDir: config.librarySourceDir, libraryDir: config.libraryDir })
        const written = result.written.map((row) => `${row.library}  ←  ${row.source}   ${row.entries} 条`)
        const skipped = result.skipped.map((row) => `${row.file}: ${row.reason}`)
        if (written.length === 0) {
          return `没有找到可索引的附体库。\n源目录：${config.librarySourceDir}\n已跳过的文件：\n${skipped.join('\n') || '（目录为空或没有 *.json）'}`
        }
        return [
          `索引已重建，写入 ${written.length} 个库 → ${config.libraryDir}`,
          '',
          ...written,
          skipped.length > 0 ? `\n跳过 ${skipped.length} 个文件：\n${skipped.slice(0, 10).join('\n')}` : ''
        ]
          .filter((line) => line !== '')
          .join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_status',
      description:
        'Report the live NovelAI plugin state: model and size, the effective proxy, the API key pool (counts and concurrency, never the tokens), the artist-string archive and which one is in force, whether auto-render is on, the output directory, how many images exist, and which libraries are indexed.',
      parameters: {},
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const status = await statusPayload()
        const pool = status.keySummary
        return [
          `底座：${status.baseUrl}   模型：${status.model}`,
          `尺寸：${status.width}×${status.height}   步数：${status.steps}   引导：${status.scale}   采样器：${status.sampler}`,
          `代理：${status.proxy ?? '直连'}${status.proxySetting === '' ? '（自动跟随系统）' : '（面板指定）'}`,
          `Key 池：${pool.keyCount} 个（可用 ${pool.usableKeyCount}，空闲 ${pool.availableKeyCount}）　并发度 ${pool.concurrency}` +
            (pool.problemKeyCount > 0 ? `　⚠ ${pool.problemKeyCount} 个待处理` : ''),
          `画师串：已导入 ${status.artistCount} 条　当前：${status.artistName ?? '未选择'}`,
          `自动出图：${status.autoGenerate ? '开' : '关'}`,
          pool.usableKeyCount > 0
            ? `凭据：Key 池里有 ${pool.usableKeyCount} 把可用`
            : status.tokenSet
              ? `凭据：已配置（${status.tokenSource === 'env' ? '环境变量 NAI_TOKEN' : '配置文件'}）`
              : '凭据：未配置 —— 在侧栏面板填写，或用 nai_keys add 添加',
          `出图目录：${status.outputDir}   已有 ${status.imageCount} 张`,
          `输入目录：${status.sourceDir}（nai_img2img 只能从这里读底图）`,
          `索引目录：${status.libraryDir}`,
          `源目录：${status.librarySourceDir}`,
          `每次上限：${status.maxImagesPerCall} 张`,
          `已索引的库：${status.libraries.map((row) => `${row.library}(${row.entries})`).join('、')}`
        ].join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_probe',
      description:
        'Check the host, the network path and the token WITHOUT spending Anlas, by reading the subscription record instead of rendering. ' +
        'Run this before the first real render: a 401 means the token is unusable, a network failure means the domain or proxy is wrong, and a success also reports the remaining training steps.',
      parameters: {},
      output: {
        schema: { type: 'object' },
        render: textRender((value) => (typeof value === 'string' ? value : (value?.text ?? ''))),
        presentationMeta: toolCard((_args, value) => probeView(value))
      },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const result = await probeNow({ signal: exec.signal })
        const lines = [
          `${result.ok ? '✅' : '❌'} ${result.detail}`,
          result.status === undefined ? '' : `HTTP ${result.status}　主机：${result.origin ?? '—'}`,
          result.hint ?? '',
          result.stage === 'token' && result.ok === false ? '把 token 换成 NovelAI 账号设置里的 Persistent Token（pst- 开头）。' : '',
          result.pool === undefined
            ? ''
            : `Key 池：${result.pool.keyCount} 个（可用 ${result.pool.usableKeyCount}）　并发度 ${result.pool.concurrency}` +
              (result.pool.problemKeyCount > 0 ? `　⚠ ${result.pool.problemKeyCount} 个有问题，用 nai_keys list 看详情` : '')
        ]
        if (result.subscription) {
          const s = result.subscription
          lines.push(
            '',
            `订阅档：${s.tier ?? '—'}　激活：${s.active ?? '—'}`,
            // Energy is the V5 Opus allowance; Anlas is what billed renders spend.
            formatBalance(s),
            s.energy === null ? '' : '（电量按百分比刷新，粒度太粗，不能用来核对单张消耗）'
          )
        }
        const text = lines.filter((line) => line !== '').join('\n')
        return {
          text,
          ok: result.ok === true,
          detail: String(result.detail ?? ''),
          status: result.status ?? null,
          origin: result.origin ?? null,
          stage: result.stage ?? null,
          hint: result.hint ?? '',
          subscription: result.subscription ?? null,
          pool: result.pool ?? null
        }
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_keys',
      description:
        'Manage the NovelAI API key pool. Every usable key gives one concurrent render slot, so the pool\'s breadth is exactly the number of working keys. ' +
        'Actions: `list` (labels, fingerprints, per-key state — never the tokens), `add` (needs `token`), `remove` (needs `id`), `enable`/`disable` (needs `id`), `verify` (one free subscription read per key, in parallel).',
      parameters: {
        action: { type: 'string', required: true, description: 'list | add | remove | enable | disable | verify' },
        id: { type: 'string', description: 'Key id, from `list`.' },
        label: { type: 'string', description: 'Display label for `add`.' },
        token: { type: 'string', description: 'The pst-… token for `add`.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const action = String(args.action ?? 'list').toLowerCase()
        const describePool = async () => {
          const config = await load()
          const activePool = poolFor(config)
          const summary = activePool.healthSummary()
          const lines = [
            `Key 池：${summary.keyCount} 个（可用 ${summary.usableKeyCount}，空闲 ${summary.availableKeyCount}）　并发度 ${summary.concurrency}　队列 ${summary.queuedCount}　在飞 ${summary.activeCount}`
          ]
          for (const key of activePool.list()) {
            lines.push(
              `  ${key.label}  fp=${key.fingerprint}  ${key.enabled ? 'on' : 'off'}  ${key.status}` +
                `${key.completed ? `  已完成 ${key.completed}` : ''}` +
                `${key.subscription?.tier === undefined || key.subscription?.tier === null ? '' : `  tier=${key.subscription.tier}`}` +
                `${key.lastError ? `  ⚠ ${key.lastError}` : ''}`
            )
          }
          return lines.join('\n')
        }

        if (action === 'list') return describePool()
        if (action === 'verify') {
          const config = await load()
          const activePool = poolFor(config)
          await verifyKeys(activePool, exec.signal)
          return describePool()
        }
        if (action === 'add') {
          const token = String(args.token ?? '').trim()
          if (token === '') return 'add 需要 token。'
          await persistKeys((keys) => {
            if (keys.some((key) => fingerprintOf(key.token) === fingerprintOf(token))) return keys
            keys.push({ id: randomUUID(), label: String(args.label ?? ''), token, enabled: true })
            return keys
          })
          return `已添加。\n${await describePool()}`
        }
        if (action === 'remove') {
          const id = String(args.id ?? '')
          if (id === '') return 'remove 需要 id。'
          await persistKeys((keys) => keys.filter((key) => key.id !== id))
          return `已移除。\n${await describePool()}`
        }
        if (action === 'enable' || action === 'disable') {
          const id = String(args.id ?? '')
          if (id === '') return `${action} 需要 id。`
          await persistKeys((keys) => keys.map((key) => (key.id === id ? { ...key, enabled: action === 'enable' } : key)))
          return `已${action === 'enable' ? '启用' : '停用'}。\n${await describePool()}`
        }
        return `未知 action：${action}（可用：list / add / remove / enable / disable / verify）`
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_artists',
      description:
        'Search the imported artist-string archive (画师串). Each entry is a ready-made style prefix — a positive prompt, an optional negative prompt, and a reference image. ' +
        'Call with `query` to search, or with `id` to read one entry in full so it can be prepended to a render.',
      parameters: {
        query: { type: 'string', description: 'Search text over names and prompts. Omit to list everything.' },
        id: { type: 'integer', description: 'Read one entry in full by id.' },
        select: { type: 'integer', description: 'Make this archive id the artist string in force, applied to every later render until changed.' },
        clear: { type: 'boolean', description: 'Stop applying any artist string.' },
        limit: { type: 'integer', description: 'Maximum search results, default 20.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const config = await load()
        // The merged view: the archive with the user's edits, plus 「我的画师串」.
        const index = await loadArtists(config)
        if (index.entries.length === 0) {
          return `还没有导入画师串索引（${config.artistIndex}），也没有自建的画师串。在插件目录里运行：node import-artists.mjs "<画师串.json 路径>"`
        }
        if (args.clear === true) {
          await save({ artistId: -1 })
          return '已关闭画师串：之后的出图不再叠加任何风格。'
        }
        if (args.select !== undefined && args.select !== null) {
          const picked = artistById(index, args.select)
          if (picked === null) return `没有 id=${args.select} 的画师串（共 ${index.entries.length} 条）。`
          await save({ artistId: Number(args.select) })
          return `已把「${picked.name}」(#${picked.id}) 设为当前画师串，之后每次出图都会把它前置到正向、把它的负向并入负向。\n用 nai_artists({ clear: true }) 关掉，或用 nai_artists({ select: N }) 换一条。`
        }
        if (args.id !== undefined && args.id !== null) {
          const entry = artistById(index, args.id)
          if (entry === null) return `没有 id=${args.id} 的画师串（共 ${index.entries.length} 条）。`
          const pictured = entry.hasCover || (entry.image !== null && entry.image !== undefined)
          return [
            `【#${entry.id}】${entry.name}　(sequence ${entry.sequence})${entry.user ? '　〈我的画师串〉' : entry.edited ? '　〈已修改〉' : ''}`,
            `正文 ${entry.positivePrompt.length} 字符${pictured ? '，有参考图' : '，无参考图'}`,
            '',
            '正向：',
            entry.positivePrompt,
            entry.negativePrompt === '' ? '' : `\n负向：\n${entry.negativePrompt}`,
            entry.chamiPositivePrompt === '' ? '' : `\nChami 正向：\n${entry.chamiPositivePrompt}`
          ]
            .filter((line) => line !== '')
            .join('\n')
        }
        const rows = searchArtists(index, args.query ?? '', Math.min(200, Math.max(1, Number(args.limit) || 20)))
        const lines = [`共 ${index.entries.length} 条画师串，命中 ${rows.length} 条：`]
        const grouped = index.groups.length > 1
        for (const row of rows) {
          lines.push(
            `  #${row.id}  ${row.name}  [${row.promptChars} 字符]${row.hasImage ? '  🖼' : ''}${row.edited ? '  ✎' : ''}${grouped && row.group ? `  〈${row.group}〉` : ''}`
          )
        }
        if (rows.length > 0) lines.push('\n用 nai_artists({ id }) 读全文。')
        return lines.join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_character_edit',
      description:
        "Rewrite one character in the plugin's character library with the configured prompt model: fixed DNA, variable outfits, keywords and the per-character negative. " +
        'Pass one natural-language instruction; the model returns the whole updated character. ' +
        'Without `apply` the draft is returned for review and nothing is written; with `apply: true` it is saved to characters.json. ' +
        'Omit `character` to draft a brand-new character from the instruction.',
      parameters: {
        instruction: {
          type: 'string',
          required: true,
          description: 'What to change, e.g. "把发色改成银白色，加一副黑色蕾丝眼罩，去掉兽耳".'
        },
        character: { type: 'string', description: 'Character id, exact name, or a unique name/keyword fragment. Omit to create a draft.' },
        apply: { type: 'boolean', description: 'Save the rewritten character (default false: return the draft only).' },
        group: { type: 'string', description: 'Group id or name for a new character when applying. Defaults to the first group.' }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const doc = await loadCharacters()
        const query = args.character === undefined || args.character === null ? '' : String(args.character).trim()
        const found = query === '' ? null : findCharacterInDoc(doc, query)
        const result = await editCharacter(ctx, {
          character: found,
          instruction: String(args.instruction ?? ''),
          config: await load(),
          signal: exec.signal
        })
        const draft = result.draft
        const summary = [
          found === null ? '新角色草稿' : `角色「${found.name}」`,
          draft.analysis === '' ? '' : `说明：${draft.analysis}`,
          '',
          `固定特征：${draft.fixedFeatures || '（空）'}`,
          `关键字：${draft.keywords.length > 0 ? draft.keywords.join(', ') : '（空）'}`,
          ...draft.variableFeatures.map((row, index) => `可选 ${index + 1}${row.name === '' ? '' : `「${row.name}」`}：${row.prompt || '（空）'}`),
          `负面：${draft.negative || '（空）'}`,
          draft.notes === '' ? '' : `备注：${draft.notes}`
        ].filter((line) => line !== '')
        const meta = `模型：${result.route === null ? '（未调用）' : `${result.route.provider}/${result.route.model}`}　试了 ${result.attempts} 次　logId ${result.logId}`
        if (args.apply !== true) {
          return [
            ...summary,
            '',
            meta,
            '',
            '这是草稿，还没有写入角色库。要保存：加 apply: true 再调用一次；或者让用户在面板的角色编辑器里确认后保存。'
          ].join('\n')
        }
        let groupId = found === null ? doc.groups[0]?.id : found.groupId
        if (found === null && args.group !== undefined && args.group !== null && String(args.group).trim() !== '') {
          const wanted = String(args.group).trim()
          const group = doc.groups.find((row) => row.id === wanted) ?? doc.groups.find((row) => row.name === wanted)
          if (group === undefined) {
            throw Object.assign(new Error(`没有叫「${wanted}」的分组。现有：${doc.groups.map((row) => row.name).join('、')}`), { status: 404 })
          }
          groupId = group.id
        }
        const payload = found === null ? { ...mergeEditDraft({}, draft), groupId } : mergeEditDraft(found, draft)
        const saved = await saveCharacter(payload)
        return [...summary, '', `已保存到角色库：${saved.character.name}（id ${saved.character.id}）`, meta].join('\n')
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_doctor',
      description:
        'Check that every capability of this plugin is intact against the live configuration: config field types, the key pool, the proxy path, the artist archive and its remembered selection, all five libraries, the `<image>` format parser, the browser half\'s classifier, and the output directory. ' +
        'Costs nothing and renders nothing, so run it after any restart or code change rather than discovering a silent breakage later.',
      parameters: {},
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        return formatDoctor(await doctorReport())
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'nai_config',
      description:
        'Change the NovelAI plugin configuration. Only the fields you pass are replaced. Use this to set the token, default size, model, output directory or library directories from the conversation instead of the panel.',
      parameters: {
        token: { type: 'string', description: 'NovelAI persistent API token. Stored in $DSH_HOME/nai-imagegen/config.json.' },
        base_url: { type: 'string', description: 'API base, default https://image.novelai.net' },
        model: { type: 'string', description: 'Default model id.' },
        width: { type: 'integer', description: 'Default width.' },
        height: { type: 'integer', description: 'Default height.' },
        steps: { type: 'integer', description: 'Default sampling steps.' },
        scale: { type: 'number', description: 'Default guidance.' },
        sampler: { type: 'string', description: 'Default sampler.' },
        proxy: { type: 'string', description: 'Proxy for reaching NovelAI. Empty or "off" connects directly (the default; a relay base URL needs no proxy); "auto" uses the Windows system proxy; otherwise a URL like http://127.0.0.1:7890.' },
        uc_preset: { type: 'integer', description: 'Undesired-content preset index: 0=heavy, 1=light, 2=furryFocus, 3=humanFocus, 4=none. Default 3.' },
        negative_prompt: { type: 'string', description: 'Default negative prompt.' },
        quality_toggle: {
          type: 'boolean',
          description:
            'Append the official quality tags (`very aesthetic, masterpiece, no text`) to the end of the positive prompt. Off by default — artist strings often already carry the same words.'
        },
        header: {
          type: 'string',
          description:
            'Header text inserted at the very front of the positive prompt, ahead of the artist string. For NovelAI dataset-switch tags, which must come first — e.g. "fur dataset" for Furry Mode, "background dataset" for scenery. Empty disables it.'
        },
        decode: {
          type: 'string',
          enum: ['zip', 'json', 'auto'],
          description:
            'Response format asked of the relay. zip (default) is the smallest transfer; json mirrors nai-dbgen\'s 「解码: 自动」 and asks for a base64 JSON envelope; auto sends Accept: */* and decodes whatever comes back.'
        },
        output_dir: { type: 'string', description: 'Where PNGs are written.' },
        source_dir: {
          type: 'string',
          description:
            'Directory nai_img2img may read base images from (PNG/JPEG/WebP, ≤24MB, ≤3,047,424 px total). Empty derives it from the output directory: <outputDir>/../../_in/nai.'
        },
        library_dir: { type: 'string', description: 'Directory holding <库名>.jsonl indexes.' },
        library_source_dir: { type: 'string', description: 'Directory holding the original world-book JSONs.' },
        max_images_per_call: { type: 'integer', description: 'Billing guard: variants allowed per call.' },
        keep_images: { type: 'integer', description: 'Keep only the newest N images on disk; 0 disables trimming.' },
        artist_id: { type: 'integer', description: 'The artist string in force, by archive id; -1 for none. Same setting as nai_artists select.' },
        artist_index: { type: 'string', description: 'Where the artist index lives.' },
        artist_source: { type: 'string', description: 'Override the archive path recorded inside the artist index.' },
        auto_generate: { type: 'boolean', description: 'Whether prompt-looking code blocks in the transcript render by themselves.' },
        code_buttons: {
          type: 'boolean',
          description: 'Inject the 「🎨 生图」 button under prompt-looking code blocks (default off; off also stops the transcript scan).'
        }
      },
      output: { schema: { type: 'string' }, render: textRender((value) => value) },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const patch = {}
        const map = {
          token: 'token',
          base_url: 'baseUrl',
          model: 'model',
          width: 'width',
          height: 'height',
          steps: 'steps',
          scale: 'scale',
          sampler: 'sampler',
          proxy: 'proxy',
          uc_preset: 'ucPreset',
          negative_prompt: 'negativePrompt',
          quality_toggle: 'qualityToggle',
          header: 'header',
          decode: 'decode',
          output_dir: 'outputDir',
          source_dir: 'sourceDir',
          library_dir: 'libraryDir',
          library_source_dir: 'librarySourceDir',
          max_images_per_call: 'maxImagesPerCall',
          keep_images: 'keepImages',
          artist_id: 'artistId',
          artist_index: 'artistIndex',
          artist_source: 'artistSource',
          auto_generate: 'autoGenerate',
          code_buttons: 'codeButtons'
        }
        for (const [key, field] of Object.entries(map)) {
          if (args[key] !== undefined) patch[field] = args[key]
        }
        if (Object.keys(patch).length === 0) return '没有需要修改的字段。'
        await save(patch)
        const names = Object.keys(patch).join('、')
        return `已更新：${names}\n${await statusPayload().then((s) => `凭据：${s.tokenSet ? '已配置' : '仍未配置'}`)}`
      }
    })
  )

  // ------------------------------------------------------------------ api --
  /**
   * Answer one panel request. The handler owns the whole response lifecycle,
   * matching the route contract.
   */
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && route === '/status') return sendJson(res, 200, await statusPayload())

      if (method === 'GET' && route === '/config') {
        const config = await load()
        const token = await tokenOf(config)
        // The token is never echoed back; only its origin.
        const { token: _omitted, ...rest } = config
        return sendJson(res, 200, {
          ...rest,
          tokenSet: token.length > 0,
          tokenSource: (process.env.NAI_TOKEN || '').trim() ? 'env' : token ? 'file' : 'none'
        })
      }

      if (method === 'POST' && route === '/config') {
        const body = await readJsonBody(req)
        const allowed = [
          'baseUrl',
          'token',
          'model',
          'width',
          'height',
          'steps',
          'scale',
          'sampler',
          'ucPreset',
          'proxy',
          'negativePrompt',
          'outputDir',
          'sourceDir',
          'libraryDir',
          'librarySourceDir',
          'maxImagesPerCall',
          'keepImages',
          'autoGenerate',
          'codeButtons',
          'mode',
          'modes',
          'artistSource',
          'artistIndex',
          'artistId',
          // 头部插入。不加进白名单的话，面板能输入但保存时会被这里丢弃，
          // 表现为「填了没反应」——这类静默失效比报错难查得多。
          'header',
          'qualityToggle',
          // 解码格式（json / zip / auto）。同样必须进白名单，否则面板里选完
          // 保存会被这里静默丢弃，表现为「选了没反应」。
          'decode',
          'llmProvider',
          'llmModel',
          'llmMaxTokens',
          'writerRetries',
          'cfgRescale',
          'noiseSchedule',
          'variety',
          'connectTimeoutMs',
          'transparentBackground',
          'smea'
        ]
        const patch = {}
        for (const key of allowed) if (body[key] !== undefined) patch[key] = body[key]
        if (Object.keys(patch).length === 0) return sendJson(res, 400, { error: 'no known fields in body' })
        await save(patch)
        return sendJson(res, 200, { ok: true, updated: Object.keys(patch), status: await statusPayload() })
      }

      // ---------------------------------------------------------- api keys --
      if (method === 'GET' && route === '/keys') {
        const config = await load()
        const activePool = poolFor(config)
        return sendJson(res, 200, { keys: activePool.list(), summary: activePool.healthSummary() })
      }

      if (method === 'POST' && route === '/keys/add') {
        const body = await readJsonBody(req)
        const token = String(body.token ?? '').trim()
        if (token === '') return sendJson(res, 400, { error: 'token is required' })
        await persistKeys((keys) => {
          const fingerprint = fingerprintOf(token)
          if (keys.some((key) => fingerprintOf(key.token) === fingerprint)) return keys
          keys.push({ id: randomUUID(), label: String(body.label ?? ''), token, enabled: true })
          return keys
        })
        return sendJson(res, 200, { ok: true, status: await statusPayload() })
      }

      if (method === 'POST' && route === '/keys/update') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        await persistKeys((keys) =>
          keys.map((key) =>
            key.id === id
              ? {
                  ...key,
                  label: body.label === undefined ? key.label : String(body.label),
                  enabled: body.enabled === undefined ? key.enabled : body.enabled === true
                }
              : key
          )
        )
        return sendJson(res, 200, { ok: true, status: await statusPayload() })
      }

      if (method === 'POST' && route === '/keys/remove') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        await persistKeys((keys) => keys.filter((key) => key.id !== id))
        return sendJson(res, 200, { ok: true, status: await statusPayload() })
      }

      if (method === 'POST' && route === '/keys/verify') {
        const config = await load()
        const activePool = poolFor(config)
        // One probe per key, in parallel, outside the render queue: a verify is a
        // report on each key, not work that can be moved elsewhere, and it must
        // not wait behind a render.
        await verifyKeys(activePool)
        return sendJson(res, 200, { ok: true, keys: activePool.list(), summary: activePool.healthSummary() })
      }

      if (method === 'GET' && route === '/doctor') {
        const report = await doctorReport()
        return sendJson(res, report.ok ? 200 : 500, report)
      }

      // -------------------------------------------------------------- model --
      // The language model is DSH's own. `ctx` here is the plugin's root context
      // captured by `apply`, so `ctx.get('llm')` sees whatever the host has
      // mounted at request time; nothing is injected, so the plugin still loads
      // and renders on a host without the LLM stack.
      if (method === 'GET' && route === '/llm/status') {
        return sendJson(res, 200, await llmStatus(ctx, await load()))
      }

      if (method === 'GET' && route === '/llm/models') {
        return sendJson(res, 200, { providers: await llmModels(ctx) })
      }

      // ------------------------------------------------------------ presets --
      if (method === 'GET' && route === '/presets') return sendJson(res, 200, await loadPresets())

      if (method === 'POST' && route === '/presets') {
        const body = await readJsonBody(req)
        return sendJson(res, 200, await savePresets(body))
      }

      if (method === 'POST' && route === '/presets/reset') {
        const body = await readJsonBody(req)
        return sendJson(res, 200, await resetPreset(String(body.name ?? '')))
      }

      // ----------------------------------------------------- prompt writer --
      // 「写提示词」 and 「反推」: one model call (plus corrective retries) that
      // returns a structured caption for the workbench editor. Nothing renders.
      if (method === 'POST' && route === '/write') {
        const body = await readJsonBody(req, MAX_IMAGE_BODY_BYTES)
        const naturalLanguage = String(body.naturalLanguage ?? '').trim()
        const image = typeof body.image === 'string' && body.image !== '' ? body.image : null
        // Both refusals are logged (writePrompt logs the empty one itself), so even
        // a 400 carries a `logId`.
        if (image !== null && !image.startsWith('data:image/')) throw loggedBadRequest('write', '参考图必须是 data:image/… 格式', { naturalLanguage })
        const config = await load()
        const result = await writePrompt(ctx, {
          naturalLanguage,
          image,
          references: Array.isArray(body.references) ? body.references : [],
          characterIds: Array.isArray(body.characterIds) ? body.characterIds : [],
          width: body.width,
          height: body.height,
          config,
          signal: disconnectSignal(res)
        })
        return sendJson(res, 200, result)
      }

      // --------------------------------------------------------- characters --
      // Every document sent back carries `hasCover` per character (and the stored
      // `coverVersion`), so the panel can show reference pictures without asking.
      if (method === 'GET' && route === '/characters') return sendJson(res, 200, await withCoverFlags(await loadCharacters()))

      if (method === 'POST' && route === '/characters/group') {
        const body = await readJsonBody(req)
        const doc = await saveGroup(body.group ?? body)
        return sendJson(res, 200, { ok: true, doc: await withCoverFlags(doc) })
      }

      if (method === 'POST' && route === '/characters/group/delete') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        return sendJson(res, 200, { ok: true, doc: await withCoverFlags(await deleteGroup(id)) })
      }

      if (method === 'POST' && route === '/characters/save') {
        const body = await readJsonBody(req)
        const saved = await saveCharacter(body.character ?? body)
        const doc = await withCoverFlags(saved.doc)
        return sendJson(res, 200, { ok: true, doc, character: doc.characters.find((row) => row.id === saved.character.id) })
      }

      if (method === 'POST' && route === '/characters/delete') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        return sendJson(res, 200, { ok: true, doc: await withCoverFlags(await deleteCharacter(id)) })
      }

      // Render one reference picture for a character through the normal render
      // path (so it lands in the gallery too) and, unless told otherwise, keep it
      // as the character's cover.
      if (method === 'POST' && route === '/characters/preview') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') throw loggedBadRequest('render', 'id is required', { kind: 'preview' })
        const character = (await loadCharacters()).characters.find((row) => row.id === id)
        if (character === undefined) throw Object.assign(loggedBadRequest('render', '角色不存在', { kind: 'preview', characterId: id }), { status: 404 })
        const variant =
          body.variant === undefined || body.variant === null ? null : (character.variableFeatures[Number(body.variant)] ?? null)
        if (body.variant !== undefined && body.variant !== null && variant === null) {
          throw loggedBadRequest('render', `角色「${character.name}」没有第 ${Number(body.variant) + 1} 个非固定特征`, { kind: 'preview' })
        }
        const prompt = typeof body.prompt === 'string' && body.prompt.trim() !== '' ? body.prompt.trim() : characterPreviewPrompt(character, variant)
        if (prompt === '') throw loggedBadRequest('render', `角色「${character.name}」还没有固定特征，没法画参考图`, { kind: 'preview' })
        const result = await renderLogged('preview', {
          prompt,
          // Always the illustration path: a reference picture is one plain prompt.
          mode: 'illustration',
          width: body.width ?? 832,
          height: body.height ?? 1216,
          nSamples: 1,
          ...(body.artistId === undefined || body.artistId === null ? {} : { artistId: Number(body.artistId) }),
          ...(character.negative !== '' ? { negativePrompt: [character.negative, (await load()).negativePrompt].filter((text) => String(text ?? '').trim() !== '').join(', ') } : {}),
          signal: disconnectSignal(res)
        })
        let saved = null
        if (body.setCover !== false && result.files.length > 0) {
          saved = await setCharacterCover(id, result.files[0].file)
        }
        const doc = await withCoverFlags(saved?.doc ?? (await loadCharacters()))
        return sendJson(res, 200, {
          ok: true,
          files: result.files,
          request: result.request,
          character: doc.characters.find((row) => row.id === id),
          doc,
          logId: result.logId
        })
      }

      // Use a gallery render as a character's reference picture.
      if (method === 'POST' && route === '/characters/cover') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        if (body.from === undefined || body.from === null || body.from === '') return sendJson(res, 400, { error: 'from is required' })
        const config = await load()
        const saved = await setCharacterCover(id, safeJoin(await outputDirOf(config), String(body.from)))
        const doc = await withCoverFlags(saved.doc)
        return sendJson(res, 200, { ok: true, doc, character: doc.characters.find((row) => row.id === id) })
      }

      if (method === 'POST' && route === '/characters/cover/delete') {
        const body = await readJsonBody(req)
        const id = String(body.id ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        const saved = await deleteCharacterCover(id)
        const doc = await withCoverFlags(saved.doc)
        return sendJson(res, 200, { ok: true, doc, character: doc.characters.find((row) => row.id === id) })
      }

      if (method === 'GET' && route === '/character-image') {
        const id = String(url.searchParams.get('id') ?? '')
        if (id === '') return sendJson(res, 400, { error: 'id is required' })
        let bytes
        try {
          bytes = await readFile(characterCoverFile(id))
        } catch {
          return sendJson(res, 404, { error: '这个角色还没有参考图' })
        }
        // Replaced at any time, so never cached as fresh; the panel adds
        // `coverVersion` to the URL to tell versions apart.
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'Content-Length': bytes.length })
        return res.end(bytes)
      }

      if (method === 'GET' && route === '/characters/export') {
        const payload = await exportCharacters(url.searchParams.get('group') || undefined)
        const text = `${JSON.stringify(payload, null, 2)}\n`
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="nai-characters.json"',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(text)
        })
        return res.end(text)
      }

      if (method === 'POST' && route === '/characters/import') {
        const body = await readJsonBody(req, MAX_IMPORT_BODY_BYTES)
        let payload = body.payload
        // The panel may hand over the file's text unparsed.
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload)
          } catch (error) {
            return sendJson(res, 400, { error: `文件不是有效的 JSON：${error.message}` })
          }
        }
        if (payload === undefined || payload === null) return sendJson(res, 400, { error: 'payload is required' })
        const result = await importCharacters(payload, {
          groupId: body.groupId ? String(body.groupId) : undefined,
          onDuplicate: body.onDuplicate
        })
        return sendJson(res, 200, { ok: true, ...result, doc: await withCoverFlags(result.doc) })
      }

      // ------------------------------------------------------- tag market --
      if (method === 'GET' && route === '/market') return sendJson(res, 200, await loadMarket())

      if (method === 'POST' && route === '/market/import') {
        const body = await readJsonBody(req, MAX_IMPORT_BODY_BYTES)
        if (body.catalog === undefined || body.catalog === null) return sendJson(res, 400, { error: 'catalog is required' })
        return sendJson(res, 200, await importMarket(body.catalog))
      }

      if (method === 'GET' && route === '/market/export') {
        const { catalog } = await loadMarket()
        if (catalog === null) return sendJson(res, 404, { error: '尚未导入标签超市' })
        const text = `${JSON.stringify(catalog, null, 2)}\n`
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="nai-tag-market.json"',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(text)
        })
        return res.end(text)
      }

      // A character's DNA read off a reference picture: a draft, not saved.
      if (method === 'POST' && route === '/characters/from-image') {
        const body = await readJsonBody(req, MAX_IMAGE_BODY_BYTES)
        const result = await dnaFromImage(ctx, {
          image: body.image,
          hint: body.hint,
          config: await load(),
          signal: disconnectSignal(res)
        })
        return sendJson(res, 200, result)
      }

      // 「用提示词改特征」: one model call rewrites the character from a sentence.
      // Nothing is saved by default: the panel drops the draft into the edit form
      // so the user can read it before committing. `apply: true` saves directly
      // (used by the `nai_character_edit` tool, not by the form).
      if (method === 'POST' && route === '/characters/ai-edit') {
        const body = await readJsonBody(req, MAX_IMAGE_BODY_BYTES)
        const instruction = String(body.instruction ?? '').trim()
        if (instruction === '') return sendJson(res, 400, { error: '先写一句要怎么改这个角色' })
        const id = body.id === undefined || body.id === null ? '' : String(body.id)
        const doc = await loadCharacters()
        const stored = id === '' ? null : (doc.characters.find((row) => row.id === id) ?? null)
        if (id !== '' && stored === null) return sendJson(res, 404, { error: '角色不存在' })
        // The editor may hold unsaved fields; prefer them over the stored record
        // so "rewrite what I see" is what the model actually gets.
        const base = body.character !== undefined && body.character !== null ? body.character : stored
        const result = await editCharacter(ctx, {
          character: base,
          instruction,
          config: await load(),
          signal: disconnectSignal(res)
        })
        const draft = result.draft
        if (body.apply !== true || stored === null) {
          return sendJson(res, 200, {
            ok: true,
            applied: false,
            draft,
            analysis: draft.analysis,
            route: result.route,
            attempts: result.attempts,
            logId: result.logId
          })
        }
        const saved = await saveCharacter(mergeEditDraft(stored, draft))
        const next = await withCoverFlags(saved.doc)
        return sendJson(res, 200, {
          ok: true,
          applied: true,
          draft,
          analysis: draft.analysis,
          route: result.route,
          attempts: result.attempts,
          logId: result.logId,
          doc: next,
          character: next.characters.find((row) => row.id === stored.id)
        })
      }

      // ---------------------------------------------------------- libraries --
      // The same three operations the Agent has as nai_lookup / nai_resolve /
      // nai_index, exposed for the sidebar's library browser.
      if (method === 'GET' && route === '/libraries') {
        const config = await load()
        return sendJson(res, 200, {
          known: LIBRARIES,
          indexed: await listLibraries(config.libraryDir),
          libraryDir: config.libraryDir,
          librarySourceDir: config.librarySourceDir
        })
      }

      if (method === 'GET' && route === '/lookup') {
        const config = await load()
        const library = url.searchParams.get('library') || undefined
        return sendJson(
          res,
          200,
          await lookup(url.searchParams.get('q') ?? '', {
            libraryDir: config.libraryDir,
            library: library !== undefined && LIBRARIES.includes(library) ? library : undefined,
            limit: Math.min(40, Math.max(1, Number(url.searchParams.get('limit')) || 20)),
            maxChars: 4000
          })
        )
      }

      if (method === 'GET' && route === '/resolve') {
        const config = await load()
        return sendJson(
          res,
          200,
          await resolveCharacter(url.searchParams.get('q') ?? '', {
            libraryDir: config.libraryDir,
            limit: Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 8))
          })
        )
      }

      if (method === 'POST' && route === '/index') {
        const config = await load()
        const result = await rebuildIndex({ sourceDir: config.librarySourceDir, libraryDir: config.libraryDir })
        return sendJson(res, 200, { ...result, indexed: await listLibraries(config.libraryDir) })
      }

      // ------------------------------------------------------------ artists --
      if (method === 'GET' && route === '/artists') {
        const config = await load()
        // The merged view, so saved edits and 「我的画师串」 list like any archive.
        const index = await loadArtists(config)
        const query = url.searchParams.get('q') ?? ''
        const group = url.searchParams.get('group') ?? ''
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 60))
        return sendJson(res, 200, {
          index: config.artistIndex,
          source: config.artistSource || index.sourceFile || '',
          count: index.entries.length,
          groups: index.groups,
          artists: searchArtists(index, query, limit, group)
        })
      }

      if (method === 'GET' && route === '/artist') {
        const config = await load()
        const entry = artistById(await loadArtists(config), url.searchParams.get('id'))
        if (entry === null) return sendJson(res, 404, { error: 'unknown artist' })
        return sendJson(res, 200, entry)
      }

      // Save an artist string from the workbench: an archive id writes its
      // override, a user id updates it, no id creates a 「我的画师串」 entry.
      // `coverFrom` names a gallery PNG (checked like `/file`) to use as the cover.
      if (method === 'POST' && route === '/artists/user/save') {
        const body = await readJsonBody(req)
        const config = await load()
        const coverPath =
          body.coverFrom === undefined || body.coverFrom === null || body.coverFrom === ''
            ? null
            : safeJoin(await outputDirOf(config), String(body.coverFrom))
        const result = await saveUserArtist(config, body, coverPath)
        return sendJson(res, 200, result)
      }

      // 「替换画师串预览」: only the cover changes, never the text.
      if (method === 'POST' && route === '/artists/user/cover') {
        const body = await readJsonBody(req)
        if (body.id === undefined || body.id === null || body.id === '') return sendJson(res, 400, { error: '请先选择画师串' })
        if (body.from === undefined || body.from === null || body.from === '') return sendJson(res, 400, { error: '请先出图，再用这张图替换预览' })
        const config = await load()
        const result = await setArtistCover(config, body.id, safeJoin(await outputDirOf(config), String(body.from)))
        return sendJson(res, 200, result)
      }

      // Delete a user entry, or revert an archive entry to the archived text.
      if (method === 'POST' && route === '/artists/user/delete') {
        const body = await readJsonBody(req)
        if (body.id === undefined || body.id === null || body.id === '') return sendJson(res, 400, { error: 'id is required' })
        const config = await load()
        const result = await deleteUserArtist(config, body.id)
        // A deleted user entry must not stay "in force": its id is never reused,
        // so a stale selection would silently render with no style at all.
        if (result.removed === 'entry') {
          const patch = {}
          if (Number(config.artistId) === result.id) patch.artistId = -1
          const modes = config.modes ?? {}
          if (Object.values(modes).some((row) => Number(row?.artistId) === result.id)) {
            patch.modes = Object.fromEntries(
              Object.entries(modes).map(([mode, row]) => [mode, Number(row?.artistId) === result.id ? { ...row, artistId: -1 } : row])
            )
          }
          if (Object.keys(patch).length > 0) await save(patch)
        }
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'GET' && route === '/artist-image') {
        const config = await load()
        const view = await loadArtists(config)
        const index = view.index
        const entry = artistById(view, url.searchParams.get('id'))
        if (entry === null) return sendJson(res, 404, { error: 'unknown artist' })
        // A saved cover wins over the archive's picture, for both sizes. It can be
        // replaced at any time, so it is not cached; the panel adds the row's
        // `coverVersion` to the URL so an archive picture cached under the same
        // id is not shown instead.
        if (entry.hasCover) {
          const bytes = await readFile(coverFileOf(entry.id))
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'Content-Length': bytes.length })
          return res.end(bytes)
        }
        if (entry.user) return sendJson(res, 404, { error: 'this entry has no reference image' })
        // `thumb=1` asks for the archive's own small preview (~36 KB instead of
        // ~2 MB), which is what a picker grid wants; it falls back to the full image.
        const wantThumb = url.searchParams.get('thumb') === '1'
        const picture = wantThumb && entry.thumb ? entry.thumb : entry.image
        if (picture === null || picture === undefined) return sendJson(res, 404, { error: 'this entry has no reference image' })
        // Read straight out of the archive: not one byte is copied to disk.
        const bytes = await readArtistImage({
          sourceFile: artistSourceOf(index, entry, config.artistSource),
          image: picture
        })
        res.writeHead(200, {
          'Content-Type': picture.mime,
          // The archive is immutable in practice, so a day of caching is safe and
          // saves re-decoding a 1.7 MB base64 payload per scroll.
          'Cache-Control': 'private, max-age=86400',
          'Content-Length': bytes.length
        })
        return res.end(bytes)
      }

      if (method === 'GET' && route === '/gallery') {
        const config = await load()
        const outputDir = await outputDirOf(config)
        const limit = Number(url.searchParams.get('limit')) || 120
        const offset = Number(url.searchParams.get('offset')) || 0
        const page = await listImages(outputDir, { limit, offset, extensions: ['.png'] })
        return sendJson(res, 200, {
          outputDir,
          // width / height / seed come from each batch's sidecar when there is one.
          files: await withRenderMeta(outputDir, page.files),
          total: page.total,
          offset,
          hasMore: offset + page.files.length < page.total
        })
      }

      if (method === 'GET' && route === '/gallery/stats') {
        const config = await load()
        const outputDir = await outputDirOf(config)
        const all = await listImages(outputDir, { limit: Number.MAX_SAFE_INTEGER, extensions: ['.png'], all: true })
        return sendJson(res, 200, {
          count: all.total,
          bytes: all.files.reduce((sum, row) => sum + row.bytes, 0),
          outputDir,
          keepImages: config.keepImages
        })
      }

      // Delete renders. Names are checked like `/file` (a plain name inside the
      // output directory); a batch's sidecar goes when its last PNG goes.
      if (method === 'POST' && route === '/gallery/delete') {
        const body = await readJsonBody(req)
        const names = Array.isArray(body.names) ? body.names.map((name) => String(name ?? '')) : null
        if (names === null || names.length === 0) return sendJson(res, 400, { error: 'names is required' })
        const config = await load()
        const outputDir = await outputDirOf(config)
        // Validate every name before deleting any, so one bad name deletes nothing.
        for (const name of names) {
          safeJoin(outputDir, name)
          if (!/\.png$/i.test(name)) return sendJson(res, 400, { error: `只能删除图库里的 PNG：${name}` })
        }
        const result = await deleteRenders(outputDir, names)
        return sendJson(res, 200, { ok: true, deleted: result.deleted.length, missing: result.missing })
      }

      // Keep the newest N renders and delete the rest (`keep: 0` = all).
      if (method === 'POST' && route === '/gallery/trim') {
        const body = await readJsonBody(req)
        const keep = Number(body.keep)
        if (!Number.isInteger(keep) || keep < 0) return sendJson(res, 400, { error: 'keep 必须是 ≥ 0 的整数' })
        const config = await load()
        const outputDir = await outputDirOf(config)
        const all = await listImages(outputDir, { limit: Number.MAX_SAFE_INTEGER, extensions: ['.png'], all: true })
        const result = await deleteRenders(outputDir, all.files.slice(keep).map((row) => row.name))
        return sendJson(res, 200, { ok: true, deleted: result.deleted.length })
      }

      if (method === 'GET' && route === '/file') {
        const config = await load()
        const outputDir = await outputDirOf(config)
        const file = safeJoin(outputDir, url.searchParams.get('name'))
        const bytes = await readFile(file)
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'Content-Length': bytes.length
        })
        return res.end(bytes)
      }

      // ------------------------------------------------------- img2img sources --
      if (method === 'GET' && route === '/sources') {
        const config = await load()
        const sourceDir = await sourceDirOf(config)
        const limit = Number(url.searchParams.get('limit')) || 120
        const offset = Number(url.searchParams.get('offset')) || 0
        const page = await listImages(sourceDir, { limit, offset, extensions: SOURCE_EXTENSIONS })
        return sendJson(res, 200, {
          sourceDir,
          files: page.files,
          total: page.total,
          offset,
          hasMore: offset + page.files.length < page.total
        })
      }

      // A preview of the selected base image. `safeJoin` is reused rather than a
      // second path check: the name still arrives from the browser, and one
      // boundary implementation is easier to trust than two.
      if (method === 'GET' && route === '/source-file') {
        const config = await load()
        const sourceDir = await sourceDirOf(config)
        const file = safeJoin(sourceDir, url.searchParams.get('name'))
        const bytes = await readFile(file)
        const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
        const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
          'Content-Length': bytes.length
        })
        return res.end(bytes)
      }

      // A base image chosen through the browser's file picker. The browser half
      // cannot hand over a path (the file lives in the renderer), so the bytes
      // arrive over the loopback API and land in the source directory — the same
      // place `/sources` already lists, so there is still exactly one readable
      // root for img2img.
      if (method === 'POST' && route === '/source-upload') {
        const config = await load()
        const sourceDir = await sourceDirOf(config)
        const bytes = await readBinaryBody(req, MAX_UPLOAD_BYTES)
        if (bytes.length === 0) return sendJson(res, 400, { error: '上传内容为空' })
        const sniffed = sniffImage(bytes)
        if (sniffed === null) return sendJson(res, 400, { error: '只接受 PNG/JPEG/WebP 图片' })
        if (sniffed.width !== null && sniffed.height !== null && sniffed.width * sniffed.height > MAX_SOURCE_PIXELS) {
          return sendJson(res, 400, {
            error:
              `图片 ${sniffed.width}×${sniffed.height} = ${(sniffed.width * sniffed.height).toLocaleString('en-US')} px，` +
              `超过 NovelAI 的 ${MAX_SOURCE_PIXELS.toLocaleString('en-US')} px 上限`
          })
        }
        const requested = safeSourceName(url.searchParams.get('name') ?? 'upload')
        const extension = EXTENSION_BY_MIME[sniffed.mime] ?? '.png'
        const stem = requested.slice(0, requested.length - extname(requested).length)
        await mkdir(sourceDir, { recursive: true })
        const name = await uniqueSourceName(sourceDir, `${stem}${extension}`)
        await writeFile(join(sourceDir, name), bytes)
        return sendJson(res, 200, {
          ok: true,
          name,
          bytes: bytes.length,
          mime: sniffed.mime,
          width: sniffed.width,
          height: sniffed.height
        })
      }

      if (method === 'POST' && route === '/probe') {
        const started = Date.now()
        const result = await probeNow({ signal: disconnectSignal(res) })
        const logId = logEvent('probe', {
          level: result.ok ? 'info' : 'warn',
          summary: result.ok ? `连接测试通过 · ${Date.now() - started} ms` : `连接测试失败：${String(result.detail ?? '').slice(0, 80)}`,
          ok: result.ok === true,
          ms: Date.now() - started,
          stage: result.stage ?? null,
          status: result.status ?? null,
          ...(result.ok ? {} : { error: result.detail ?? null, ...(result.code ? { code: result.code } : {}), ...(result.networkCode ? { networkCode: result.networkCode } : {}) })
        })
        return sendJson(res, 200, { ...result, balance: balanceOf(result.subscription), logId })
      }

      // ---------------------------------------------------------------- logs --
      // The debug log (lib/log.js): what each prompt-writing call sent and got
      // back, every render, probe and unexpected failure.
      if (method === 'GET' && route === '/logs') {
        return sendJson(res, 200, {
          entries: await readLog({
            limit: url.searchParams.get('limit') ?? undefined,
            event: url.searchParams.get('event') ?? undefined,
            level: url.searchParams.get('level') ?? undefined,
            day: url.searchParams.get('day') ?? undefined,
            since: url.searchParams.get('since') ?? undefined
          }),
          days: await logDays(),
          dir: LOG_DIR
        })
      }

      if (method === 'GET' && route === '/logs/download') {
        const day = String(url.searchParams.get('day') ?? '')
        const file = logFileOf(day)
        if (file === null) return sendJson(res, 400, { error: 'day 必须是 YYYY-MM-DD' })
        await flushLog()
        let bytes
        try {
          bytes = await readFile(file)
        } catch {
          return sendJson(res, 404, { error: `${day} 没有日志` })
        }
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="nai-imagegen-${day}.jsonl"`,
          'Cache-Control': 'no-store',
          'Content-Length': bytes.length
        })
        return res.end(bytes)
      }

      if (method === 'POST' && route === '/logs/clear') {
        return sendJson(res, 200, { ok: true, removed: await clearLog() })
      }

      // Remaining Anlas and V5 energy, per enabled key: one free subscription read
      // each, in parallel, outside the render queue and with the probe's short
      // deadline, so it answers even while a render is running or stuck.
      if (method === 'GET' && route === '/balance') {
        const balanceStarted = Date.now()
        const config = await load()
        const activePool = poolFor(config)
        const signal = disconnectSignal(res)
        const keys = activePool.list().filter((key) => key.enabled)
        const rows = await Promise.all(
          keys.map(async (key) => {
            const base = { id: key.id, label: key.label, fingerprint: key.fingerprint }
            try {
              const result = await activePool.bypass({ kind: 'probe' }, { keyId: key.id, signal })
              const balance = balanceOf(result.subscription)
              if (balance === null) return { ...base, ok: false, tier: null, anlas: null, energy: null, error: result.detail ?? '订阅接口没有返回余额' }
              return { ...base, ok: true, ...balance }
            } catch (error) {
              return {
                ...base,
                ok: false,
                tier: null,
                anlas: null,
                energy: null,
                error: error?.message ?? String(error),
                ...(error?.code ? { code: error.code } : {})
              }
            }
          })
        )
        const failed = rows.filter((row) => !row.ok)
        logEvent('balance', {
          level: failed.length > 0 ? 'warn' : 'info',
          summary:
            failed.length > 0
              ? `余额查询：${rows.length - failed.length}/${rows.length} 把 Key 成功`
              : `余额查询成功 · ${rows.length} 把 Key · Anlas 共 ${rows.reduce((sum, row) => sum + (row.anlas?.total ?? 0), 0)}`,
          ok: failed.length === 0,
          ms: Date.now() - balanceStarted,
          keys: rows.map((row) => ({ label: row.label, fingerprint: row.fingerprint, ok: row.ok, anlas: row.anlas?.total ?? null, energy: row.energy?.percent ?? null, ...(row.error ? { error: row.error } : {}) }))
        })
        return sendJson(res, 200, { keys: rows, checkedAt: new Date().toISOString() })
      }

      // Bytes received so far for one panel render; the panel polls this while
      // it waits, so a slow relay download reads as progress instead of a hang.
      if (method === 'GET' && route === '/render-progress') {
        const id = String(url.searchParams.get('id') ?? '')
        const entry = id === '' ? null : (renderProgress.get(id) ?? null)
        return sendJson(res, 200, entry ?? { status: 'unknown' })
      }

      if (method === 'POST' && route === '/generate') {
        const body = await readJsonBody(req)
        // img2img fields are forwarded only when present: an empty string must
        // read as "no base image", not as a path the Host will fail to open.
        const sourceImage =
          body.sourceImage === undefined || body.sourceImage === '' ? undefined : String(body.sourceImage)
        // Optional: the panel's short id for polling download progress.
        const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.requestId) ? body.requestId : ''
        const tracker = requestId === '' ? null : trackRenderProgress(requestId)
        try {
          const { files, request, weight, concurrency, source, replacedCharacters, logId } = await renderLogged(sourceImage === undefined ? 'generate' : 'img2img', {
            ...workbenchOptions(body),
            prompt: body.prompt,
            caption: body.caption,
            negativePrompt: body.negativePrompt,
            width: body.width,
            height: body.height,
            steps: body.steps,
            seed: body.seed,
            nSamples: body.nSamples,
            model: body.model,
            sampler: body.sampler,
            scale: body.scale === undefined ? undefined : Number(body.scale),
            ucPreset: body.ucPreset === undefined ? undefined : Number(body.ucPreset),
            qualityToggle: body.qualityToggle,
            sourceImage,
            strength: body.strength === undefined ? undefined : Number(body.strength),
            noise: body.noise === undefined ? undefined : Number(body.noise),
            ...(tracker === null ? {} : { progress: tracker.entry, onProgress: tracker.onProgress }),
            signal: disconnectSignal(res)
          })
          tracker?.finish('done')
          return sendJson(res, 200, { ok: true, files, request, weight, concurrency, source: source ?? null, replacedCharacters, logId })
        } catch (error) {
          tracker?.finish('error')
          throw error
        }
      }

      // The sidecar of one gallery image: the request that produced it, so the
      // workbench can load a render back. Same name check as `/file`.
      if (method === 'GET' && route === '/file-meta') {
        const config = await load()
        const outputDir = await outputDirOf(config)
        const file = safeJoin(outputDir, url.searchParams.get('name'))
        const meta = await readSidecar(file)
        if (meta === null) return sendJson(res, 404, { error: '这张图没有参数记录' })
        return sendJson(res, 200, meta)
      }

      // -------------------------------------------------------- director tools --
      if (method === 'POST' && route === '/director') {
        const body = await readJsonBody(req)
        const started = Date.now()
        const facts = { tool: String(body.type ?? ''), from: body.from === 'source' ? 'source' : 'gallery', source: String(body.name ?? '') }
        let files
        try {
          files = await runDirectorTool({
            from: facts.from,
            name: facts.source,
            type: facts.tool,
            prompt: body.prompt === undefined ? null : String(body.prompt),
            emotion: body.emotion === undefined ? null : String(body.emotion),
            defry: body.defry === undefined ? null : Number(body.defry),
            signal: disconnectSignal(res)
          })
        } catch (error) {
          error.logId = logEvent('director', {
            level: 'error',
            summary: `导演工具失败（${facts.tool}）：${String(error?.message ?? error).slice(0, 80)}`,
            ...facts,
            ok: false,
            ms: Date.now() - started,
            error: String(error?.message ?? error),
            ...(error?.code ? { code: error.code } : {})
          })
          throw error
        }
        const logId = logEvent('director', {
          level: 'info',
          summary: `导演工具完成（${facts.tool}）· ${Date.now() - started} ms`,
          ...facts,
          ok: true,
          ms: Date.now() - started,
          files: files.map((file) => file.name)
        })
        return sendJson(res, 200, { ok: true, files, logId })
      }

      if (method === 'POST' && route === '/inpaint') {
        const body = await readJsonBody(req, MAX_INPAINT_BODY_BYTES)
        let image
        let mask
        try {
          image = decodeInlineImage(body.base, 'base')
          mask = decodeInlineMask(body.mask)
        } catch (error) {
          throw loggedBadRequest('render', error.message, { kind: 'inpaint' })
        }
        const config = await load()
        const requestedModel = String(body.model ?? '').trim()
        const inpainting = inpaintingModelFor(requestedModel === '' ? config.model : requestedModel)
        const model = inpainting.model
        const result = await renderLogged('inpaint', {
          ...workbenchOptions(body),
          prompt: body.prompt,
          caption: body.caption,
          negativePrompt: body.negativePrompt,
          width: body.width,
          height: body.height,
          steps: body.steps,
          seed: body.seed,
          nSamples: body.nSamples,
          model,
          sampler: body.sampler,
          scale: body.scale === undefined ? undefined : Number(body.scale),
          ucPreset: body.ucPreset === undefined ? undefined : Number(body.ucPreset),
          qualityToggle: body.qualityToggle,
          inlineImage: image,
          inlineMask: mask,
          addOriginalImage: body.addOriginalImage !== false,
          inpaintStrength: body.inpaintStrength === undefined ? undefined : Number(body.inpaintStrength),
          signal: disconnectSignal(res)
        })
        return sendJson(res, 200, {
          ok: true,
          files: result.files,
          request: result.request,
          weight: result.weight,
          concurrency: result.concurrency,
          source: result.source,
          mask: result.mask,
          replacedCharacters: result.replacedCharacters,
          // E.g. V5 Curated has no inpainting model, so V5 Full's was used.
          notes: inpainting.note === '' ? [] : [inpainting.note],
          logId: result.logId
        })
      }

      return sendJson(res, 404, { error: `unknown route ${method} ${route}` })
    } catch (error) {
      // Anything not already logged by its own route (render, write, …) is logged
      // here, so no failure the panel shows is missing from 日志.
      if (error !== null && typeof error === 'object' && !error.logId) {
        // Recomputed: the try block's `method` / `route` are not in scope here.
        const method = String(req.method ?? 'GET').toUpperCase()
        let route = String(req.url ?? '/')
        try {
          route = new URL(route, 'http://127.0.0.1').pathname.slice(API_PREFIX.length) || '/'
        } catch {
          // keep the raw url
        }
        error.logId = logEvent('error', {
          level: 'error',
          summary: `接口出错：${method} ${route} · ${String(error?.message ?? error).slice(0, 80)}`,
          route: `${method} ${route}`,
          error: String(error?.message ?? error),
          ...(error?.code ? { code: error.code } : {}),
          stack: String(error?.stack ?? '').slice(0, 2000)
        })
      }
      // The client may already be gone (an aborted write, or a cancelled render);
      // then there is no one to answer, and writing would only raise a second error.
      if (res.headersSent || res.writableEnded || res.destroyed) return
      sendError(res, error)
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), `${ROW_ID}: api`)

  // ------------------------------------------------------------- dsh-go ------
  // Native Android slots. `dshGo` exists only on a host that runs the dsh-go
  // bridge (the app's own Linux engine); on a desktop/web host this callback
  // never runs, so the plugin stays exactly the web plugin it was before.
  // `inject` itself is guarded because the offline test host mounts `apply`
  // without a cordis injector.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['dshGo'], (goCtx) => {
    goCtx.dshGo.panel('novelai', {
      view: (_scope, caps) => panelView(caps),
      data: (_scope, emit, caps) => {
        let alive = true
        // The first emit uses anything already cached; only a missing balance
        // costs one free probe. After that the panel re-reads local state every
        // two minutes, and 刷新余额 forces a real subscription read.
        const send = async (refresh) => {
          try {
            const data = await buildDshGoData({ refresh, locale: caps?.locale })
            if (alive) emit(data)
          } catch (failure) {
            if (alive) emit({ ...(dshGoCache.data ?? {}), error: String(failure?.message ?? failure) })
          }
        }
        send(dshGoCache.data?.balance == null).catch(() => {})
        const timer = setInterval(() => send(false), 120000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      },
      actions: {
        refresh: () => ({
          pending: { label: '刷新中', timeoutMs: 45000 },
          result: async () => {
            const data = await buildDshGoData({ refresh: true })
            return { patch: data, toast: data.error === '' ? '已刷新' : '刷新失败' }
          }
        }),
        useCharacter: (_scope, event) => {
          const id = String(event?.value?.id ?? '')
          const character = (dshGoCache.data?.characters ?? []).find((row) => row.id === id)
          if (character === undefined) return { toast: '角色不在了' }
          return { insert: character.insertText, toast: '已插入关键字' }
        },
        copyFile: (_scope, event) => {
          const path = String(event?.value?.path ?? '')
          return path === '' ? { toast: '没有路径' } : { copy: path, toast: '已复制路径' }
        }
      }
    })
    goCtx.dshGo.strip('nai-balance', (_scope, emit, caps) => {
      let alive = true
      const push = async () => {
        try {
          // No network here: the balance comes from the pool's cached
          // subscription record, refreshed by the panel or by any probe.
          const data = dshGoCache.data ?? (await buildDshGoData({ locale: caps?.locale }))
          if (alive) emit(stripText(data, caps))
        } catch {
          // A strip that cannot read state stays silent; it must never throw.
        }
      }
      push()
      const timer = setInterval(push, 60000)
      return () => {
        alive = false
        clearInterval(timer)
      }
    })
    })
  }
}

