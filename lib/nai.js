/**
 * dsh-nai-imagegen — NovelAI image API client.
 *
 * Deliberately dependency-free: the only imports are Node built-ins, so this
 * package installs by `link:` with nothing to fetch and nothing to build.
 *
 * The request body below is aligned field-for-field with a measured V5
 * contract rather than with guesswork, because the failure modes here are
 * expensive and unintuitive:
 *
 *   - `nai-diffusion-5-full` is the current model id and the default. Do not
 *     conclude that the older `nai-diffusion-4-5-full` is invalid: real output
 *     on this machine names `NovelAI Diffusion V4.5` as its source. What the
 *     measurements do establish is the **host** — posting to the retired
 *     `api.novelai.net` returns `400 model must be a valid enum value`, which
 *     reads like a bad model id but is a stale endpoint.
 *   - V5 **requires** both `v4_prompt` and `v4_negative_prompt`. Omitting either
 *     returns `500 Internal Server Error`, not a validation 400 — so it reads
 *     like an outage while the cause is the body.
 *   - The prompt travels in three places at once: top level `input`,
 *     `parameters.prompt`, and `v4_prompt.caption.base_caption`.
 *   - `params_version` is ignored by this skeleton (4/3/1/0 render identical
 *     pixels); we send 4 to match the official web client.
 *   - `Content-Type: application/json` must be set explicitly when posting JSON;
 *     Node's `fetch` builds the multipart boundary itself, so hand-setting it on
 *     a `FormData` body breaks the request.
 *   - The official response is a zip (`image_0.png` inside) delivered as
 *     `binary/octet-stream`. Proxy/relay deployments sometimes answer with JSON
 *     holding base64 instead, so both are decoded here.
 *
 * Failure handling, including why there is no automatic retry: see
 * `GENERATE_PATH` and `generate()` below.
 */
import { inflateRawSync, inflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DEFAULT_CONNECT_TIMEOUT_MS, httpRequest, isConnectFailure, resolveProxy } from './net.js'

/**
 * Extra attempts for a request that never reached the origin.
 *
 * The relay's edge answers on a fresh TCP/TLS connection that occasionally
 * never comes up at all (a reset or a blackholed handshake). Such a failure
 * cannot have generated anything — the request body never left this machine —
 * so retrying it is free of billing risk and is what turns "one unlucky
 * connection" into a working render. A failure after the connection was up is
 * deliberately *not* retried here: the model may already have run and the key
 * pool is the layer that decides about those.
 */
const CONNECT_RETRY_ATTEMPTS = 2
/** Backoff between connect-phase attempts: 500ms, then 1.4s, plus jitter. */
const connectRetryDelay = (attempt) => 500 + attempt * 900 + Math.floor(Math.random() * 300)
/** @param {number} ms - how long to wait. @returns {Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run one request, retrying only failures that happened before any connection.
 * @param {() => Promise<any>} run - performs the request.
 * @param {AbortSignal|null} signal - the caller's abort signal.
 * @returns the request's result.
 */
async function withConnectRetry(run, signal) {
  let lastError = null
  for (let attempt = 0; attempt <= CONNECT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw error
      if (!isConnectFailure(error) || attempt === CONNECT_RETRY_ATTEMPTS) throw error
      await wait(connectRetryDelay(attempt))
    }
  }
  throw lastError
}
import { isWithin, resolveWithin } from './util.js'
import { modelFamily, usesStructuredCaption } from './models.js'

/** Path appended to a bare base URL. */
const GENERATE_PATH = '/ai/generate-image'
/** Subscription/balance lookup; used by `probe` to validate a token for free. */
const SUBSCRIPTION_PATH = '/user/subscription'

/**
 * Deadlines for the free subscription read. A probe answers "can I reach
 * NovelAI at all", so it must answer in seconds — never wait out a render-sized
 * timeout on a dead route.
 */
export const PROBE_CONNECT_TIMEOUT_MS = 10000
export const PROBE_TIMEOUT_MS = 15000

/** Director Tools endpoint; a raw image goes in, a raw image comes back. */
const AUGMENT_PATH = '/ai/augment-image'

/** The Director Tools this client exposes — the five that cost no Anlas. */
export const DIRECTOR_TYPES = ['lineart', 'sketch', 'colorize', 'emotion', 'declutter']

/** Locally deflate-compressed ZIP members. */
const METHOD_DEFLATE = 8
/** Stored (uncompressed) ZIP members. */
const METHOD_STORE = 0

/** Image extensions a NovelAI archive may carry. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

/**
 * Expand a ZIP archive into its members.
 *
 * Only what a NovelAI response needs is supported: no encryption, no ZIP64 and
 * no data descriptors. Anything else throws rather than returning a truncated
 * image.
 *
 * @param buf - the whole archive.
 * @returns one `{ name, data }` entry per member, in central-directory order.
 */
export function unzip(buf) {
  // The end-of-central-directory record is last, optionally followed by a
  // comment, so search backwards within the largest legal comment window.
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('response is not a zip archive: no end-of-central-directory record')

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []

  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`malformed zip: central directory entry ${n} is unreadable`)
    }
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const uncompressedSize = buf.readUInt32LE(offset + 24)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`malformed zip: local header for ${name} is unreadable`)
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = buf.subarray(start, start + compressedSize)

    let data
    if (method === METHOD_STORE) data = Buffer.from(raw)
    else if (method === METHOD_DEFLATE) data = inflateRawSync(raw)
    else throw new Error(`unsupported zip compression method ${method} in ${name}`)

    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new Error(`zip member ${name} expanded to ${data.length} bytes, expected ${uncompressedSize}`)
    }
    entries.push({ name, data })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Snap a requested size into the supported range and to a multiple of 64,
 * which is what the NovelAI image models accept.
 * @param value - requested pixels on one axis.
 * @param fallback - value used when the request is absent or unusable.
 * @returns a legal axis length.
 */
export function legalAxis(value, fallback) {
  const n = Number(value)
  const base = Number.isFinite(n) && n > 0 ? n : fallback
  const snapped = Math.round(base / 64) * 64
  return Math.min(2048, Math.max(64, snapped))
}

/**
 * The pixel product an Opus subscription renders without spending Anlas:
 * one image, at or below this area, and 28 steps or fewer.
 *
 * 1024x1024 and both 832x1216 orientations land inside it; anything larger is
 * billed. An img2img base image does **not** enter this test: NovelAI's own
 * "Focused Inpainting" documentation says an Opus subscriber can inpaint
 * regions on large images at zero Anlas cost, so the free band follows the
 * output canvas, not the source pixels.
 */
export const FREE_AREA = 1024 * 1024

/**
 * How heavy one request is relative to the reference render (832x1216 at 28
 * steps). This is a shape-only weight, not a price: NovelAI bills an Opus
 * subscription nothing inside the free band and something above it, so the
 * number is reported as a relative cost the caller can reason about.
 * @param size - width, height, steps and sample count.
 * @returns the relative weight, rounded to two decimals.
 */
export function costWeight({ width, height, steps, nSamples = 1 }) {
  const referenceArea = 832 * 1216
  const area = Math.max(1, width) * Math.max(1, height)
  const stepFactor = Math.max(1, steps) / 28
  return Math.round((area / referenceArea) * stepFactor * Math.max(1, nSamples) * 100) / 100
}

/**
 * Whether a request should fall inside the Opus free band.
 * @param size - width, height, steps and sample count.
 * @returns true when no Anlas should be spent.
 */
export function insideFreeBand({ width, height, steps, nSamples = 1 }) {
  return width * height <= FREE_AREA && steps <= 28 && nSamples <= 1
}

/**
 * Build the generation URL from whatever the user put in `baseUrl`.
 *
 * Three shapes have to work, because all three appear in the wild and pasting
 * one into the other's field is the normal mistake: a bare origin, an origin
 * ending in `/ai`, and a full endpoint URL copied from a proxy's docs.
 *
 * @param baseUrl - the configured base.
 * @returns the absolute generate-image URL.
 */
export function resolveGenerateUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') throw new Error('baseUrl is empty')
  if (/\/ai\/generate-image$/i.test(trimmed)) return trimmed
  if (/\/ai$/i.test(trimmed)) return `${trimmed}/generate-image`
  return `${trimmed}${GENERATE_PATH}`
}

/**
 * The origin of the configured base, for the free subscription probe.
 * @param baseUrl - the configured base.
 * @returns `scheme://host`.
 */
export function resolveOrigin(baseUrl) {
  try {
    return new URL(String(baseUrl ?? '').trim()).origin
  } catch {
    throw new Error(`baseUrl is not a URL: ${baseUrl}`)
  }
}

/**
 * Parse the two registry values that describe the Windows system proxy.
 *
 * Split out from the query itself so the parsing is testable without touching
 * the registry. The server is reported even when the switch is off: a proxy
 * that is *recorded but disabled* is the most common reason a direct connection
 * hangs on a machine that can only reach NovelAI through one, and saying so is
 * the useful hint.
 *
 * `ProxyServer` may also be per-protocol (`http=h:p;https=h:p`); the https entry
 * is preferred, as NovelAI is https.
 *
 * @param text - the output of `reg query …Internet Settings`.
 * @returns `{ enabled, server, url }`; `server` is `host:port` or `''`, `url` is
 *   the proxy URL when enabled, else `null`.
 */
export function parseRegProxyInfo(text) {
  const flag = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(text ?? ''))
  const enabled = flag !== null && Number.parseInt(flag[1], 16) !== 0
  const raw = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(String(text ?? ''))?.[1]?.trim() ?? ''
  let server = raw
  if (raw.includes('=')) {
    const parts = Object.fromEntries(
      raw
        .split(';')
        .map((part) => part.split('=').map((piece) => piece.trim()))
        .filter((pair) => pair.length === 2 && pair[1] !== '')
        .map(([scheme, value]) => [scheme.toLowerCase(), value])
    )
    server = parts.https ?? parts.http ?? Object.values(parts)[0] ?? ''
  }
  const url = server === '' ? null : /^[a-z][a-z0-9+.-]*:\/\//i.test(server) ? server : `http://${server}`
  return { enabled, server, url: enabled ? url : null }
}

/**
 * Parse the registry output into the proxy URL in force.
 * @param text - the output of `reg query …Internet Settings`.
 * @returns the proxy URL, or `null` when no proxy is enabled.
 */
export function parseRegProxy(text) {
  return parseRegProxyInfo(text).url
}

/** Last system-proxy reading, and when it was taken. */
let proxyCache = { enabled: false, server: '', url: null }
let proxyCacheAt = 0
/** How long a reading stays good. The registry lookup spawns a process. */
const PROXY_TTL_MS = 5000

/**
 * Read the Windows system proxy settings, enabled or not.
 *
 * Cached briefly on purpose: this spawns `reg.exe` (about 60 ms), and it sits on
 * both the status path and the render path, where every parallel job asks for
 * it. Five seconds is far shorter than any human notices a proxy change and far
 * longer than a burst of requests.
 *
 * @param options - `{ fresh: true }` bypasses the cache.
 * @returns `{ enabled, server, url }`.
 */
export function systemProxyInfo(options = {}) {
  if (process.platform !== 'win32') return { enabled: false, server: '', url: null }
  const now = Date.now()
  if (options.fresh !== true && now - proxyCacheAt < PROXY_TTL_MS) return { ...proxyCache }
  try {
    const text = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 }
    )
    proxyCache = parseRegProxyInfo(text)
  } catch {
    proxyCache = { enabled: false, server: '', url: null }
  }
  proxyCacheAt = now
  return { ...proxyCache }
}

/**
 * Read the Windows system proxy, if one is enabled.
 * @param options - `{ fresh: true }` bypasses the cache.
 * @returns the proxy URL, or `null`.
 */
export function systemProxy(options = {}) {
  return systemProxyInfo(options).url
}

/**
 * Explain why a connection failed, in terms of the setting the user actually has.
 *
 * Requests tunnel through `lib/net.js`, so the system proxy works without any
 * launch-time flag. What is left to explain is which route was taken and why it
 * did not work — above all the case where Windows still records a proxy whose
 * switch is off, so the plugin goes direct and the direct route is blackholed.
 *
 * @param activeProxy - the proxy the failed request used, if any.
 * @param error - the transport error, when there is one (`code`, `proxyHop`).
 * @param options - `{ host, system }`; `system` overrides the registry reading
 *   (for tests).
 * @returns a one- or two-sentence diagnosis.
 */
export function proxyHint(activeProxy = null, error = null, options = {}) {
  const host = options.host ?? 'image.novelai.net'
  const code = String(error?.code ?? '')
  const viaProxy = activeProxy !== null && activeProxy !== undefined && activeProxy !== ''
  const proxyLabel = viaProxy ? String(activeProxy).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '') : ''

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return viaProxy
      ? `代理 ${proxyLabel} 的地址解析不了，检查 设置 → 连接 → 代理 里填的地址。`
      : `解析不了 ${host} 的域名：检查 设置 → 连接 → 接口域名 是否写对、网络是否通。`
  }
  if (viaProxy) {
    if (error?.proxyHop === true && ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(code)) {
      return `代理 ${proxyLabel} 没有在监听，代理软件可能没开。打开它，或在 设置 → 连接 → 代理 里改成能用的地址。`
    }
    if (code === 'EPROXY_CONNECT') {
      return `代理 ${proxyLabel} 拒绝转发到 ${host}：检查代理软件的规则是否覆盖了这个域名，或换一个节点。`
    }
    if (code === 'ECONNECT_TIMEOUT' || code === 'EPROXY_TIMEOUT') {
      return `经代理 ${proxyLabel} 在限定时间内连不上 ${host}：代理的节点可能不可用，换一个节点再试。`
    }
    return `本次请求经代理 ${proxyLabel} 发出；代理可能拒绝连接，或其分流规则没有覆盖 ${host}。`
  }
  return `直连 ${host} 失败：请检查 设置 → 连接 → 接口域名（官方地址或中转地址）是否写对、网络是否通；需要代理时在 代理 里填代理地址。`
}

/**
 * Turn a transport failure into the error the panel shows.
 *
 * `code: 'NAI_UNREACHABLE'` marks "never got an answer from NovelAI" for the
 * client; `networkCode` keeps the transport's own code, and `connectFailure`
 * tells the key pool not to retry.
 *
 * @param error - the error from `httpRequest`.
 * @param url - the URL that was requested.
 * @param proxy - the proxy that was used, or `null`.
 * @returns the error to throw.
 */
export function unreachableError(error, url, proxy) {
  let host = 'image.novelai.net'
  try {
    host = new URL(url).host
  } catch {
    // keep the default
  }
  const code = String(error?.code ?? '')
  const reason =
    code === 'ECONNECT_TIMEOUT'
      ? '在限定时间内没有连上'
      : code === 'ECONNREFUSED'
        ? '连接被拒绝'
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? '域名解析失败'
          : code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
            ? '网络不可达'
            : code === 'EPROXY_CONNECT'
              ? '代理拒绝转发'
              : code === 'EPROXY_TIMEOUT'
                ? '代理没有及时应答'
                : code === 'ERESPONSE_TIMEOUT'
                  ? '连上了但迟迟没有应答'
                  : String(error?.message ?? error)
  const hint = proxyHint(proxy, error, { host })
  return Object.assign(new Error(`连不上 NovelAI（${host}）：${reason}。${hint}`), {
    cause: error,
    code: 'NAI_UNREACHABLE',
    networkCode: code || 'NETWORK_ERROR',
    statusCode: 0,
    connectFailure: isConnectFailure(error),
    phase: error?.phase,
    proxy: proxy ?? null,
    hint
  })
}

/**
 * Resolve the proxy a request should use: the configured value, falling back to
 * the machine's own system proxy.
 * @param config - the loaded configuration, if the caller has one.
 * @returns the proxy URL, or `null` for a direct connection.
 */
export function proxyFor(config) {
  const setting = String(config?.proxy ?? '').trim().toLowerCase()
  return resolveProxy(config?.proxy, setting === 'auto' || setting === 'system' ? systemProxy() : null)
}


/**
 * Classify a response body so the right decoder is chosen even when the
 * content type lies.
 *
 * Content type alone is not enough: the official endpoint answers
 * `binary/octet-stream` for a zip, and relays answer `text/html` for a JSON
 * error. Magic bytes settle it.
 *
 * @param bytes - the response body.
 * @returns `zip`, `png`, `jpeg`, `webp`, `json` or `unknown`.
 */
export function sniffKind(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    return byte === 0x7b || byte === 0x5b ? 'json' : 'unknown'
  }
  return 'unknown'
}

/**
 * Strip a `data:` URL prefix when a relay returns its base64 that way.
 * @param value - the raw string.
 * @returns the bare base64 payload.
 */
export function stripDataUrl(value) {
  const text = String(value ?? '')
  const comma = text.indexOf(',')
  if (text.startsWith('data:') && comma >= 0) return text.slice(comma + 1)
  return text
}

/**
 * Collect base64 image payloads out of a relay's JSON envelope.
 *
 * The shapes accepted are the ones seen in the wild and in the reference
 * implementation: an array of strings, an array of `{ image | base64 | data,
 * seed? }`, an object wrapping any of those under `images` / `data` / `output`,
 * or a single `{ image, seed? }`.
 *
 * @param parsed - the decoded JSON.
 * @returns `{ base64, seed }` rows.
 */
export function normalizeImageItems(parsed) {
  const items = []
  /**
   * Walk one array of candidate entries.
   * @param list - the array to read.
   */
  const readArray = (list) => {
    for (const entry of list) {
      if (typeof entry === 'string') {
        items.push({ base64: entry, seed: null })
        continue
      }
      if (entry !== null && typeof entry === 'object') {
        const payload = entry.image ?? entry.base64 ?? entry.data
        if (typeof payload === 'string') {
          items.push({ base64: payload, seed: typeof entry.seed === 'number' ? entry.seed : null })
        }
      }
    }
  }

  if (Array.isArray(parsed)) readArray(parsed)
  else if (parsed !== null && typeof parsed === 'object') {
    const list = parsed.images ?? parsed.data ?? parsed.output
    if (Array.isArray(list)) readArray(list)
    else if (typeof parsed.image === 'string') {
      items.push({ base64: parsed.image, seed: typeof parsed.seed === 'number' ? parsed.seed : null })
    }
  }
  return items
}

/**
 * Decode a JSON body into image buffers.
 * @param bytes - the response body.
 * @returns the decoded image buffers, in order.
 */
function decodeJsonImages(bytes) {
  const text = bytes.toString('utf8').trim()
  if (text === '') throw new Error('NovelAI answered with an empty JSON body')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`NovelAI answered with unparseable JSON: ${text.slice(0, 200)}`)
  }
  const items = normalizeImageItems(parsed)
  if (items.length === 0) {
    throw new Error(
      `NovelAI JSON carried no image (expected { images: [{ image, seed? }] } or an array of base64 strings): ${text.slice(0, 200)}`
    )
  }
  return items.map((item) => {
    const buffer = Buffer.from(stripDataUrl(item.base64).replace(/\s+/g, ''), 'base64')
    if (buffer.length === 0) throw new Error('a base64 image payload decoded to zero bytes')
    return buffer
  })
}

/**
 * The `Accept` header for one configured decoder.
 *
 * `zip` is the default because the same image costs about a third fewer bytes
 * that way — which matters on a relay whose download is the bottleneck. `json`
 * mirrors nai-dbgen's 「解码: 自动」; `auto` accepts whatever the relay sends and
 * lets `decodeResponse` sniff it.
 *
 * @param mode - `zip` | `json` | `auto`, any case.
 * @returns the Accept header value.
 */
export function acceptForDecode(mode) {
  const value = String(mode ?? '').trim().toLowerCase()
  if (value === 'json') return 'application/json'
  if (value === 'zip') return 'application/zip, application/octet-stream'
  return '*/*'
}

/**
 * Turn one response body into image buffers, choosing the decoder by content
 * type and then by what the bytes actually are.
 *
 * @param bytes - the response body.
 * @param contentType - the response's content type, if any.
 * @returns the decoded image buffers.
 */
export function decodeResponse(bytes, contentType) {
  const declared = String(contentType ?? '').toLowerCase()
  if (declared.includes('json')) return decodeJsonImages(bytes)

  const kind = sniffKind(bytes)
  if (kind === 'zip') {
    const images = unzip(bytes)
      .filter((entry) => IMAGE_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension)))
      .map((entry) => entry.data)
    if (images.length === 0) throw new Error('NovelAI archive held no image member')
    return images
  }
  if (kind === 'png' || kind === 'jpeg' || kind === 'webp') return [bytes]
  if (kind === 'json') return decodeJsonImages(bytes)

  // Ambiguous: a relay that answered with the wrong content type. Try both, and
  // report both attempts if neither works.
  const failures = []
  try {
    const images = unzip(bytes)
      .filter((entry) => IMAGE_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension)))
      .map((entry) => entry.data)
    if (images.length > 0) return images
    failures.push('zip held no image member')
  } catch (error) {
    failures.push(`zip: ${error.message}`)
  }
  try {
    return decodeJsonImages(bytes)
  } catch (error) {
    failures.push(`json: ${error.message}`)
  }
  throw new Error(
    `unrecognized NovelAI response (content-type ${declared || 'unknown'}, ${bytes.length} bytes) — ${failures.join('; ')}`
  )
}

/**
 * Assemble the request body for the current NovelAI models.
 *
 * Field-for-field the shape a measured V5 call accepts; see the module comment
 * for which omissions turn into a 500 rather than a 400.
 *
 * @param options - prompt, negative prompt, model and sampling parameters.
 * @returns the JSON-serializable request body.
 */
/**
 * Convert a 5×5 grid cell to a normalised centre point.
 *
 * NovelAI's own grid runs A–E left to right and 1–5 top to bottom, so A1 is the
 * top-left corner and C3 is the middle. The API takes a normalised point, and each
 * cell becomes the centre of its square: A→0.1 … E→0.9, 1→0.1 … 5→0.9.
 *
 * @param cell - a cell such as `B3`. `auto` and anything unparseable yield null.
 * @returns the point, or null.
 */
function cellToPoint(cell) {
  const match = /^([A-Ea-e])\s*([1-5])$/.exec(String(cell ?? '').trim())
  if (match === null) return null
  return {
    x: Number(((match[1].toUpperCase().charCodeAt(0) - 65) * 0.2 + 0.1).toFixed(2)),
    y: Number(((Number(match[2]) - 1) * 0.2 + 0.1).toFixed(2))
  }
}

/**
 * Map a character's grid cells to the API's coordinates list.
 *
 * Never returns an empty list. The API rejects a `char_captions` row whose
 * `centers` is empty with a bare `500 {"statusCode":500,"message":"Internal
 * Server Error"}` — whichever way the `use_coords` flags are set, and whether the
 * field is empty or absent. All of that was established by probing the live API.
 *
 * So a character with no usable cell — `auto`, a missing marker, or a cell off the
 * grid — is placed at the centre. That is the only neutral point available, and it
 * keeps the per-character split (and with it the per-character `UC`) working,
 * where dropping the split for one missing marker would silently lose it.
 *
 * @param cells - cell strings such as `['B3']`.
 * @returns the coordinates; always at least one point.
 */
function cellListToCenters(cells) {
  return (Array.isArray(cells) ? cells : [])
    .map((entry) => {
      // A comic page's `center` is already normalised to the canvas, so it passes
      // through; an illustration's `|centers:B3` is a grid cell and is mapped.
      if (entry !== null && typeof entry === 'object') {
        const x = Number(entry.x)
        const y = Number(entry.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null
        return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
      }
      return cellToPoint(entry)
    })
    .filter((point) => point !== null)
}

/** The noise schedules NovelAI accepts. */
const NOISE_SCHEDULE_IDS = ['karras', 'native', 'exponential', 'polyexponential']
// Every per-model switch below goes through `modelFamily` (lib/models.js), so a
// curated or inpainting id behaves exactly like its family's full model.

/**
 * The noise schedule to send. V5 rejects anything but karras (the official
 * client disables the selector there), and an unknown value falls back to it.
 * @param model - the model id.
 * @param requested - the configured or per-call schedule.
 * @returns the schedule id.
 */
export function noiseScheduleFor(model, requested) {
  if (modelFamily(model) === 'v5') return 'karras'
  const id = String(requested ?? '').trim().toLowerCase()
  return NOISE_SCHEDULE_IDS.includes(id) ? id : 'karras'
}

export function buildPayload(options) {
  const {
    prompt,
    negativePrompt = '',
    model,
    width,
    height,
    steps,
    scale,
    sampler,
    seed,
    nSamples = 1,
    ucPreset = 3,
    /**
     * Per-character captions from an `<image>` block:
     * `[{ positive, negative, centers: ['B3'] }]`.
     */
    characters = [],
    /** The scene-only positive, used as the base caption when characters split out. */
    sceneCaption = null,
    /** The scene-only negative, likewise. */
    sceneNegative = null,
    /**
     * Image-to-image. `action: 'img2img'` sends the base image together with the
     * prompt; text-to-image leaves all three at their defaults. `image` is the
     * bare base64 payload (no `data:` prefix), exactly what the official client
     * posts under `parameters.image`.
     */
    action = 'generate',
    image = null,
    strength = null,
    noise = null,
    /**
     * Inpainting. `action: 'infill'` sends the base image plus a mask PNG whose
     * non-transparent (alpha > 0) pixels are the region to regenerate; the mask
     * must have exactly the request's width/height. `add_original_image` keeps
     * everything outside the mask, and `inpaintStrength` is the V4+ redraw
     * strength (0..1; 1 = fully redraw the masked area).
     */
    mask = null,
    addOriginalImage = true,
    inpaintStrength = null,
    /** CFG rescale, clamped to 0..1. */
    cfgRescale = 0,
    /** karras / native / exponential / polyexponential; V5 takes karras only. */
    noiseSchedule = 'karras',
    /**
     * "Variety": skip guidance above a sigma that scales with the canvas. Only
     * the 4.5 models expose it; for every other model it is left out.
     */
    variety = false,
    /** 透明底: V5 only; sets the alpha flags the official client sends. */
    transparent = false,
    /** SMEA mode for V3: 'off' | 'smea' | 'smea_dyn'. */
    smea = 'off'
  } = options

  // V4 and V5 share the structured-caption requirement; V3 predates it and must
  // not receive the v4 blocks.
  const family = modelFamily(model)
  const modern = usesStructuredCaption(model)
  const pinned = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : null

  const parameters = {
    width,
    height,
    scale,
    sampler,
    steps,
    n_samples: nSamples,
    ucPreset,
    qualityToggle: false,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: false,
    cfg_rescale: Number.isFinite(Number(cfgRescale)) ? Math.min(1, Math.max(0, Number(cfgRescale))) : 0,
    noise_schedule: noiseScheduleFor(model, noiseSchedule),
    legacy_v3_extend: false,
    uncond_scale: 1,
    negative_prompt: negativePrompt
  }
  if (pinned !== null) {
    parameters.seed = pinned
    parameters.extra_noise_seed = pinned
  }
  // The official client's formula; the constant is 832x1216 rounded to its area.
  if (variety === true && family === 'v4.5') {
    parameters.skip_cfg_above_sigma = Math.sqrt((Number(width) * Number(height)) / 1011712) * 58
  }
  // 透明底 is a V5 feature. The prompt carries `transparent background` (renderNow
  // adds it); these are the two flags the official client sends with it.
  if (transparent === true && family === 'v5') {
    parameters.straight_alpha = true
    parameters.tag_hint_transparent_background = true
  }
  // SMEA exists for V3 only; later models reject or ignore it.
  if (family === 'v3') {
    parameters.sm = smea === 'smea' || smea === 'smea_dyn'
    parameters.sm_dyn = smea === 'smea_dyn'
  }

  if (modern) {
    parameters.params_version = 4
    // The prompt rides in three places at once; all three are set.
    parameters.prompt = prompt
    parameters.reference_image_multiple = []
    parameters.reference_information_extracted_multiple = []
    parameters.reference_strength_multiple = []

    // NovelAI's character-position feature. Each character gets its own caption
    // and, when the block asked for one, its own point on the 5x5 grid; the base
    // caption then carries the scene alone. This is what makes `Char1 UC:` apply
    // to one character instead of to the whole picture — pooling every UC into one
    // global negative suppresses the other character's features too.
    //
    // The wire shape was confirmed against the API rather than guessed: `centers`
    // must be objects (`image.Coordinates`); strings come back as
    // `cannot unmarshal string into … centers of type image.Coordinates`.
    const split = characters.filter((row) => String(row.positive ?? '').trim() !== '')
    const usingCharacters = split.length > 0
    // Position only when a character actually asked for one. The comic format's
    // `position_mode: auto` means "arrange it yourself", and substituting the
    // canvas centre for every caption would stack every character in the middle.
    // `use_coords: false` is how the API is told to arrange freely.
    const positioned = split.filter((row) => cellListToCenters(row.centers).length > 0)
    const usingCoords = usingCharacters && positioned.length > 0
    parameters.v4_prompt = {
      use_coords: usingCoords,
      use_order: usingCharacters,
      caption: {
        base_caption: usingCharacters ? String(sceneCaption ?? prompt) : prompt,
        char_captions: split.map((row) => ({
          char_caption: row.positive,
          // With coordinates on, the API wants a point per caption; one that gave
          // none gets the canvas centre, which is the least surprising default.
          centers: usingCoords ? (cellListToCenters(row.centers).length > 0 ? cellListToCenters(row.centers) : [{ x: 0.5, y: 0.5 }]) : []
        }))
      }
    }
    parameters.v4_negative_prompt = {
      use_coords: usingCoords,
      use_order: usingCharacters,
      caption: {
        base_caption: usingCharacters ? String(sceneNegative ?? negativePrompt) : negativePrompt,
        char_captions: usingCharacters
          ? split.map((row) => ({
              char_caption: String(row.negative ?? ''),
              centers: usingCoords ? (cellListToCenters(row.centers).length > 0 ? cellListToCenters(row.centers) : [{ x: 0.5, y: 0.5 }]) : []
            }))
          : []
      }
    }
  } else {
    parameters.params_version = 3
  }

  if (action === 'img2img') {
    if (typeof image !== 'string' || image === '') {
      throw new Error('img2img requires a base image (parameters.image)')
    }
    parameters.image = image
    // 0.5 is NovelAI's own suggested starting point for img2img; clamping keeps
    // a caller bug from posting a slider value the API would reject.
    parameters.strength = strength === null ? 0.5 : Math.min(0.99, Math.max(0.01, Number(strength)))
    parameters.noise = noise === null ? 0 : Math.min(0.99, Math.max(0, Number(noise)))
  }

  if (action === 'infill') {
    if (typeof image !== 'string' || image === '') {
      throw new Error('infill requires a base image (parameters.image)')
    }
    if (typeof mask !== 'string' || mask === '') {
      throw new Error('infill requires a mask (parameters.mask)')
    }
    parameters.image = image
    parameters.mask = mask
    // Keep the untouched pixels: without this the mask is advisory and the
    // model may reinterpret the whole canvas.
    parameters.add_original_image = addOriginalImage !== false
    parameters.inpaint_img2img_strength =
      inpaintStrength === null ? 1 : Math.min(1, Math.max(0, Number(inpaintStrength)))
  }

  return { input: prompt, model, action, parameters }
}

/** Largest base image accepted, measured before base64 inflation. */
export const MAX_SOURCE_BYTES = 24 * 1024 * 1024
/** Largest accepted base-image side, in pixels. */
export const MAX_SOURCE_SIDE = 8192
/**
 * NovelAI's maximum total resolution, in pixels (1024×2976 or 1536×1984).
 *
 * A base image above it is rejected by the image endpoint with a bare 500 rather
 * than a validation error. Measured against the live API on 2026-10-30:
 * 1536×1984 (exactly 3,047,424 px) renders, 1728×1728 (2,985,984 px) renders,
 * 1792×1792 (3,211,264 px) fails, and 2048×1024 (2,097,152 px) renders — so the
 * cap is on the pixel product, not on a single side.
 */
export const MAX_SOURCE_PIXELS = 3_047_424

/**
 * Read a JPEG's pixel dimensions from its start-of-frame segment.
 *
 * Walks the marker chain instead of guessing an offset, because the EXIF/ICC
 * segments a phone or editor writes come before the frame header and vary in
 * length. Returns nulls rather than throwing: an unreadable dimension only means
 * the caller cannot verify the size, not that the image is unusable.
 *
 * @param bytes - the file contents.
 * @returns width and height, either possibly null.
 */
function jpegSize(bytes) {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return { width: null, height: null }
    // SOF0..SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      if (offset + 9 > bytes.length) return { width: null, height: null }
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    }
    offset += 2 + length
  }
  return { width: null, height: null }
}

/**
 * Read a WebP's canvas size from its VP8X / VP8 / VP8L chunk.
 * @param bytes - the file contents.
 * @returns width and height, either possibly null.
 */
function webpSize(bytes) {
  if (bytes.length < 30) return { width: null, height: null }
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    }
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  return { width: null, height: null }
}

/**
 * Identify a base image from its magic bytes and read its dimensions.
 *
 * Sniffing beats trusting the extension: a `.png` that is actually a WebP is
 * common after a browser download, and posting it as PNG is what produces an
 * opaque upstream 400.
 *
 * @param bytes - the file contents.
 * @returns `{ mime, width, height }`, or null when the format is not accepted.
 */
export function sniffImage(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ...jpegSize(bytes) }
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ...webpSize(bytes) }
  }
  return null
}

/**
 * Read and validate one base image for an img2img request.
 *
 * The source directory is the security boundary: the tool is model-invoked, so a
 * path it invents must not be able to read an arbitrary file off the user's disk
 * and ship it to NovelAI. Everything here fails loudly with the reason instead
 * of silently sending a substituted image.
 *
 * @param options - `{ root, filePath, maxBytes?, maxSide? }`.
 * @returns `{ base64, mime, width, height, bytes, name }`.
 */
export async function readBaseImage(options) {
  const { root, filePath, maxBytes = MAX_SOURCE_BYTES, maxSide = MAX_SOURCE_SIDE } = options
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new Error('source_image 为空')
  // Pure-path rejection first, so `..` is refused as a path instead of being
  // resolved to something inside the directory by accident.
  const absolute = resolveWithin(root, filePath)
  let info
  try {
    info = await stat(absolute)
  } catch {
    throw new Error(`底图不存在：${filePath}（源目录：${root}）`)
  }
  if (!info.isFile()) throw new Error(`底图不是文件：${filePath}`)
  if (info.size === 0) throw new Error(`底图是空文件：${filePath}`)
  if (info.size > maxBytes) {
    throw new Error(`底图 ${(info.size / 1048576).toFixed(1)}MB，超过上限 ${Math.round(maxBytes / 1048576)}MB：${filePath}`)
  }
  // A symlink inside the source directory could point anywhere; check the real
  // path after resolution, not just the requested one.
  const real = await realpath(absolute).catch(() => absolute)
  if (!isWithin(root, real)) throw new Error(`底图解析后落在源目录之外：${filePath}`)
  const bytes = await readFile(real)
  const sniffed = sniffImage(bytes)
  if (sniffed === null) throw new Error(`底图不是 PNG/JPEG/WebP：${filePath}（魔数不匹配）`)
  if (sniffed.width !== null && (sniffed.width > maxSide || sniffed.height > maxSide)) {
    throw new Error(`底图 ${sniffed.width}×${sniffed.height} 超过单边 ${maxSide}px 上限：${filePath}`)
  }
  // The pixel-product cap is the one that actually matters: NovelAI answers a
  // too-large base image with a bare 500, so it is worth refusing locally with a
  // message that names the number the user has to get under.
  if (sniffed.width !== null && sniffed.height !== null && sniffed.width * sniffed.height > MAX_SOURCE_PIXELS) {
    throw new Error(
      `底图 ${sniffed.width}×${sniffed.height} = ${(sniffed.width * sniffed.height).toLocaleString('en-US')} px，` +
        `超过 NovelAI 的 ${MAX_SOURCE_PIXELS.toLocaleString('en-US')} px 上限（超限时服务端直接返回 500）：${filePath}`
    )
  }
  return {
    base64: bytes.toString('base64'),
    mime: sniffed.mime,
    width: sniffed.width,
    height: sniffed.height,
    bytes: bytes.length,
    name: basename(real)
  }
}

/**
 * Turn one upstream status into an actionable message.
 *
 * The `429` wording matters: NovelAI's API document states that clients must
 * not retry, so the message tells the user to wait rather than inviting the
 * caller to loop.
 *
 * @param status - the HTTP status.
 * @param detail - the response body, already truncated.
 * @returns the message to raise.
 */
export function describeStatus(status, detail) {
  if (status === 401) {
    return (
      'NovelAI 返回 401 Unauthorized：凭据无效。' +
      '注意 401 无法区分「token 写错」和「没带 Authorization 头」，所以请检查 token 是否完整、' +
      '有没有被首尾空格或换行污染（本插件会 trim，但配置文件里可能保留了别的字符）。'
    )
  }
  if (status === 429) {
    return (
      'NovelAI 返回 429：触发限流。官方 API 文档明确要求客户端不要重试，' +
      '本插件因此不做自动重试——请等一会儿再手动发起。'
    )
  }
  if (status === 500) {
    return (
      'NovelAI 返回 500。这个状态码很可能是**请求体**的问题而不是服务故障：' +
      'V4/V5 模型必须同时带 `v4_prompt` 与 `v4_negative_prompt`，缺任一个都会得到 500 而不是 400。' +
      `原文：${detail || '(空响应体)'}`
    )
  }
  if (status === 400) {
    return (
      `NovelAI 返回 400：请求被拒。常见原因是模型 id 不是有效枚举值（当前应为 nai-diffusion-5-full）` +
      `或接口域名不对（官方是 image.novelai.net，旧的 api.novelai.net 会报 model must be a valid enum value；用中转站时填中转地址）。原文：${detail || '(空响应体)'}`
    )
  }
  return `NovelAI 返回 ${status}：${detail || '(空响应体)'}`
}

/**
 * Render one request against the NovelAI image endpoint.
 *
 * No automatic retry, on purpose: the official API document tells clients not to
 * retry, and a retried generation may be billed twice when the first attempt
 * actually reached the model but its response was lost. A failure is surfaced
 * with the upstream status so the caller decides.
 *
 * @param options - connection, prompt and sampling parameters, plus an
 *   optional abort signal.
 * @returns the decoded image buffers, in archive order.
 */
export async function generate(options) {
  const {
    baseUrl,
    token,
    signal,
    proxy = null,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    accept = '*/*',
    onProgress = null,
    ...rest
  } = options
  if (!token) throw new Error('NovelAI token is not configured; set it in the 侧栏 panel or export NAI_TOKEN')

  const url = resolveGenerateUrl(baseUrl)
  let response
  try {
    response = await withConnectRetry(
      () =>
        httpRequest({
          url,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: accept
          },
          body: JSON.stringify(buildPayload(rest)),
          proxy,
          connectTimeoutMs,
          signal,
          onProgress
        }),
      signal
    )
  } catch (error) {
    if (signal?.aborted) throw error
    // One error that names the route taken and what to change about it.
    throw unreachableError(error, url, proxy)
  }

  if (response.status < 200 || response.status >= 300) {
    // `statusCode` is what lets the key pool classify a failure — disable a key
    // on 401/403, cool it down on 429/5xx and retry elsewhere. Without it the
    // pool cannot tell a dead key from a busy one and would reject the job.
    const retryAfter = Number(response.headers['retry-after'])
    throw Object.assign(new Error(describeStatus(response.status, response.body.toString('utf8').slice(0, 400))), {
      statusCode: response.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {})
    })
  }
  return decodeResponse(response.body, response.headers['content-type'])
}

/**
 * Run one Director Tool over an image.
 *
 * `width`/`height` must equal the input image's real dimensions — the endpoint
 * answers a mismatch with a bare 500 rather than a validation error, so callers
 * read the size from the image itself.
 *
 * @param options - `{ baseUrl, token, proxy, signal, type, image, width, height, prompt?, emotion?, defry? }`.
 * @returns the output image bytes.
 */
export async function augmentImage(options) {
  const {
    baseUrl,
    token,
    signal,
    proxy = null,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    type,
    image,
    width,
    height,
    prompt = null,
    emotion = null,
    defry = null
  } = options
  if (!token) throw new Error('NovelAI token is not configured; set it in the 侧栏 panel or export NAI_TOKEN')
  if (!DIRECTOR_TYPES.includes(type)) throw new Error(`unsupported director tool: ${type}`)
  const bytes = Buffer.isBuffer(image) ? image : Buffer.from(String(image ?? ''), 'base64')
  if (bytes.length === 0) throw new Error('director tool: input image is empty')
  const url = `${resolveOrigin(baseUrl)}${AUGMENT_PATH}`
  const body = { req_type: type, width, height, image: bytes.toString('base64') }
  if (prompt !== null && String(prompt).trim() !== '') body.prompt = String(prompt)
  if (emotion !== null && String(emotion).trim() !== '') body.emotion = String(emotion)
  if (defry !== null && Number.isFinite(Number(defry))) body.defry = Math.min(5, Math.max(0, Number(defry)))

  let response
  try {
    response = await httpRequest({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: '*/*'
      },
      body: JSON.stringify(body),
      proxy,
      connectTimeoutMs,
      signal
    })
  } catch (error) {
    if (signal?.aborted) throw error
    // One error that names the route taken and what to change about it.
    throw unreachableError(error, url, proxy)
  }
  if (response.status < 200 || response.status >= 300) {
    const retryAfter = Number(response.headers['retry-after'])
    throw Object.assign(new Error(describeStatus(response.status, response.body.toString('utf8').slice(0, 400))), {
      statusCode: response.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {})
    })
  }
  const raw = response.body
  const magic = raw.subarray(0, 4)
  const isImage =
    (magic[0] === 0x89 && magic[1] === 0x50) ||
    (magic[0] === 0xff && magic[1] === 0xd8) ||
    raw.toString('ascii', 0, 4) === 'RIFF'
  if (isImage) return raw
  // Relays may answer with the archive/JSON shape the generate endpoint uses.
  const decoded = decodeResponse(raw, response.headers['content-type'])
  return decoded[0]
}

/**
 * The record that carries the balance: `/user/subscription` answers it at the
 * top level, `/user/data` nests it under `subscription`.
 * @param body - the parsed JSON.
 * @returns the record, or `{}`.
 */
function subscriptionSource(body) {
  const raw = body !== null && typeof body === 'object' ? body : {}
  const nested = raw.subscription !== null && typeof raw.subscription === 'object' ? raw.subscription : null
  return raw.trainingStepsLeft || raw.usage ? raw : (nested ?? raw)
}

/** @returns a non-negative integer, 0 for anything unusable. */
function nonNegativeInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

/**
 * Read the remaining Anlas and the V5 energy out of a subscription record.
 *
 * Ported from nai-dbgen's `subscription-balance.js`:
 *   - Anlas = `trainingStepsLeft.fixedTrainingStepsLeft` (the subscription's,
 *     reset monthly) + `trainingStepsLeft.purchasedTrainingSteps` (bought).
 *     `purchasedTrainingStepsLeft` is accepted too — earlier versions of this
 *     plugin read that name.
 *   - energy = `usage`: `percent` is the current charge, `isNegative: true`
 *     means unavailable, `timeUntilNextPercent` is seconds to the next +1% and
 *     `0` means full (refill paused). No `usage` → `null`.
 *
 * @param body - the parsed `/user/subscription` JSON.
 * @returns `{ tier, anlas: { fixed, purchased, total }, energy: { percent, unavailable, refillSeconds } | null }`.
 */
export function parseSubscriptionBalance(body) {
  const source = subscriptionSource(body)
  const steps = source.trainingStepsLeft !== null && typeof source.trainingStepsLeft === 'object' ? source.trainingStepsLeft : {}
  const fixed = nonNegativeInt(steps.fixedTrainingStepsLeft)
  const purchased = nonNegativeInt(steps.purchasedTrainingSteps ?? steps.purchasedTrainingStepsLeft)
  const usage = source.usage !== null && typeof source.usage === 'object' ? source.usage : null
  let energy = null
  if (usage !== null) {
    const percent = Number(usage.percent)
    const refill = Number(usage.timeUntilNextPercent)
    energy = {
      percent: Number.isFinite(percent) ? Math.max(0, Math.trunc(percent)) : null,
      unavailable: usage.isNegative === true,
      refillSeconds: Number.isFinite(refill) ? Math.max(0, Math.trunc(refill)) : null
    }
  }
  return { tier: source.tier ?? null, anlas: { fixed, purchased, total: fixed + purchased }, energy }
}

/**
 * One line for a balance, e.g. 「电量 87%（约 2 分钟后 +1%） · Anlas 9,930（订阅 8,000 · 购买 1,930）」.
 * @param subscription - a probe's subscription record (with `anlas`, `energy`).
 * @returns the text, or `''` when there is nothing to show.
 */
export function formatBalance(subscription) {
  if (subscription === null || subscription === undefined || subscription.anlas === undefined) return ''
  const count = (n) => String(nonNegativeInt(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const energy = subscription.energy
  let energyText = '—'
  if (energy?.unavailable) energyText = '不可用'
  else if (energy !== null && energy !== undefined && energy.percent !== null) {
    const refill = energy.refillSeconds
    const extra =
      refill === 0 ? '（已满，暂停回充）' : refill > 0 ? `（约 ${refill < 60 ? `${refill} 秒` : `${Math.round(refill / 60)} 分钟`}后 +1%）` : ''
    energyText = `${energy.percent}%${extra}`
  }
  const anlas = subscription.anlas
  return `电量 ${energyText} · Anlas ${count(anlas.total)}（订阅 ${count(anlas.fixed)} · 购买 ${count(anlas.purchased)}）`
}

/**
 * Validate the host, the network path and the token without spending Anlas.
 *
 * Reads the subscription record rather than rendering: a `200` proves the token
 * works, and the returned payload carries the remaining training steps, which is
 * what a user wants to see before their first render.
 *
 * @param options - base URL and token.
 * @returns the probe outcome.
 */
export async function probe(options) {
  const { baseUrl, token, signal, proxy = null, connectTimeoutMs = PROBE_CONNECT_TIMEOUT_MS } = options
  if (!token) return { ok: false, stage: 'token', detail: '未配置凭据，无法探测。' }
  const origin = resolveOrigin(baseUrl)
  const url = `${origin}${SUBSCRIPTION_PATH}`

  let response
  try {
    response = await withConnectRetry(
      () =>
        httpRequest({
          url,
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          proxy,
          signal,
          connectTimeoutMs,
          timeoutMs: PROBE_TIMEOUT_MS
        }),
      signal
    )
  } catch (error) {
    if (signal?.aborted) return { ok: false, stage: 'aborted', detail: '已取消' }
    const failure = unreachableError(error, url, proxy)
    return {
      ok: false,
      stage: 'network',
      code: 'NAI_UNREACHABLE',
      networkCode: failure.networkCode,
      detail: failure.message,
      hint: failure.hint,
      proxy
    }
  }

  const text = response.body.toString('utf8')
  if (response.status === 401) {
    return { ok: false, stage: 'token', status: 401, detail: `凭据被拒绝（${url}）。检查 token 是否完整、是否有多余空白。` }
  }
  if (response.status >= 500) {
    return { ok: false, stage: 'upstream', status: response.status, detail: `上游 ${response.status}：${text.slice(0, 200) || '(空)'}` }
  }
  // 2xx/3xx is a clean answer; 403/404/405 still prove the host and path are
  // reachable, which is what a connectivity probe is for.
  const reachable = response.status < 400 || [403, 404, 405].includes(response.status)
  let subscription = null
  if (response.status < 300) {
    try {
      const parsed = JSON.parse(text)
      const balance = parseSubscriptionBalance(parsed)
      const source = subscriptionSource(parsed)
      const steps = source?.trainingStepsLeft
      subscription = {
        tier: source?.tier ?? null,
        active: source?.active ?? null,
        fixedTrainingStepsLeft: steps?.fixedTrainingStepsLeft ?? null,
        purchasedTrainingStepsLeft: steps?.purchasedTrainingSteps ?? steps?.purchasedTrainingStepsLeft ?? null,
        usagePercent: source?.usage?.percent ?? null,
        // The parsed balance, so the panel never has to re-derive it.
        anlas: balance.anlas,
        energy: balance.energy
      }
    } catch {
      subscription = null
    }
  }
  return {
    ok: reachable,
    stage: response.status < 300 ? 'ok' : 'reachable',
    status: response.status,
    origin,
    detail:
      response.status < 300
        ? `凭据有效（HTTP ${response.status}）。`
        : `主机可达（HTTP ${response.status}），但订阅接口没有给出正常应答——这通常仍意味着网络与域名没问题。`,
    subscription
  }
}

/**
 * Read every textual PNG chunk into a keyword map.
 *
 * NovelAI writes its provenance as `tEXt` chunks, which is the shape verified
 * against real output; `zTXt` (same payload, deflated) is handled too because it
 * costs three lines. `iTXt` is not read — no NovelAI output has been observed
 * using it.
 *
 * @param png - one PNG buffer.
 * @returns `{ keyword: value }`.
 */
export function readTextChunks(png) {
  const fields = {}
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IEND') break
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'tEXt') {
      const nul = data.indexOf(0)
      if (nul > 0) fields[data.toString('latin1', 0, nul)] = data.toString('latin1', nul + 1)
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = data.toString('latin1', 0, nul)
        try {
          fields[keyword] = inflateSync(data.subarray(nul + 2)).toString('latin1')
        } catch {
          // A damaged chunk only costs that one field.
        }
      }
    }
    offset += 12 + length
  }
  return fields
}

/**
 * Recover what actually produced a rendered PNG.
 *
 * This is the reproducibility path, and it is not guesswork: real NovelAI output
 * carries `Software: NovelAI`, a `Source` naming the model
 * (`NovelAI Diffusion V4.5 4BDE2A90`), and a `Comment` holding the whole
 * parameter set as JSON — `{"prompt": …, "steps": 28, "width": 832, "seed": …}`.
 *
 * An earlier version of this function looked for a `seed\0<digits>` keyword,
 * which never matches that layout: `seedOf` silently returned `null` for every
 * real image, so an unpinned render was reproducible only by accident.
 *
 * @param png - one rendered image.
 * @returns the recovered provenance; fields are `null` when absent.
 */
export function metadataOf(png) {
  const fields = readTextChunks(png)
  const out = {
    software: fields.Software ?? null,
    model: fields.Source ?? null,
    seed: null,
    steps: null,
    width: null,
    height: null,
    scale: null
  }
  const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)
  if (typeof fields.Comment === 'string') {
    try {
      const comment = JSON.parse(fields.Comment)
      out.seed = numeric(comment.seed)
      out.steps = numeric(comment.steps)
      out.width = numeric(comment.width)
      out.height = numeric(comment.height)
      out.scale = numeric(comment.scale)
    } catch {
      // A non-JSON comment keeps the nulls rather than inventing values.
    }
  }
  return out
}

/**
 * Read just the seed, so an unpinned render can still be reproduced.
 * @param png - one rendered image.
 * @returns the seed, or `null`.
 */
export function seedOf(png) {
  return metadataOf(png).seed
}

/**
 * Write rendered images to disk and record the parameters beside them.
 *
 * File naming is timestamp plus index so a directory listing is naturally
 * chronological, and the sidecar JSON keeps the exact prompt and seed so a
 * render can be repeated instead of guessed at.
 *
 * @param options - output directory, images, and the request that produced them.
 * @returns one record per written file.
 */
export async function persist({ outputDir, images, request }) {
  await mkdir(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const written = []
  for (let i = 0; i < images.length; i += 1) {
    const png = images[i]
    const name = images.length === 1 ? `${stamp}.png` : `${stamp}-${i + 1}.png`
    const file = join(outputDir, name)
    await writeFile(file, png)
    // Provenance comes from the image itself, so the sidecar records what
    // actually rendered rather than what was asked for.
    const meta = metadataOf(png)
    written.push({
      file,
      // The basename is what the panel's `/file` route takes, so it travels with
      // the record instead of being re-derived from a path by every consumer.
      name,
      bytes: png.length,
      // The PNG's own record first; a pinned seed when the metadata lacks one.
      seed: meta.seed ?? (Number.isFinite(Number(request?.seed)) && Number(request.seed) > 0 ? Math.floor(Number(request.seed)) : null),
      model: meta.model,
      steps: meta.steps,
      size: meta.width !== null && meta.height !== null ? `${meta.width}x${meta.height}` : null
    })
  }
  if (written.length > 0) {
    const sidecar = join(outputDir, `${stamp}.json`)
    await writeFile(sidecar, `${JSON.stringify({ request, files: written }, null, 2)}\n`, 'utf8')
  }
  return written
}
