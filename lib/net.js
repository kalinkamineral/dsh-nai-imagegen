/**
 * dsh-nai-imagegen — HTTP transport with built-in proxy support.
 *
 * Why this exists instead of plain `fetch`:
 *
 * Node's `fetch` (undici) does **not** read the Windows system proxy, and the
 * `NODE_USE_ENV_PROXY` / `HTTPS_PROXY` pair that would make it read one is only
 * consulted at process start. Measured on Node 24.21 against a machine whose
 * system proxy is enabled:
 *
 *   | attempt                                    | result          |
 *   |--------------------------------------------|-----------------|
 *   | direct connect                             | unreachable     |
 *   | `HTTPS_PROXY` only                         | `fetch failed`  |
 *   | `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`     | works           |
 *   | `process.env.HTTPS_PROXY` set at runtime   | no effect       |
 *
 * A plugin cannot restart the host it runs in, so depending on launch-time
 * environment variables would break the feature for exactly the users who need
 * a proxy most. This module tunnels through the proxy itself using only Node
 * built-ins: a `CONNECT` handshake over a raw socket, TLS layered on top for
 * `https:`, and Node's own `http`/`https` request machinery above that — so
 * headers, status codes, chunked bodies and timeouts stay standard code rather
 * than a hand-rolled parser.
 *
 * Both protocols are supported on purpose. NovelAI is `https:`, but tunnelling
 * `http:` as well is what lets the test suite verify the handshake end to end
 * against a stub proxy without minting a certificate.
 *
 * Zero external dependencies, like the rest of the package.
 */
import { request as httpRequestPlain, Agent as HttpAgent } from 'node:http'
import { request as httpsRequestPlain, Agent as HttpsAgent } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** Ceiling on one response body; a 4-variant render is a few MB at most. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
/** Ceiling on the proxy's CONNECT response header. */
const MAX_PROXY_HEADER_BYTES = 16 * 1024
/** Ceiling on a CONNECT header the proxy itself may send back after ours. */
const CONNECT_TIMEOUT_MS = 15000
/**
 * Default deadline for the connection phase: DNS, TCP, the proxy's CONNECT and
 * the TLS handshake. A blackholed route (a direct connection on a machine that
 * can only reach the internet through a proxy) otherwise hangs until the OS
 * gives up, which on Windows is minutes — long enough for every queued render
 * to stall behind it.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 12000

/** Error codes that mean "never got a connection", as opposed to a broken one. */
const CONNECT_CODES = new Set([
  'ECONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPROXY_CONNECT',
  'EPROXY_TIMEOUT'
])

/**
 * Whether a transport error happened before any connection to the origin was
 * established. Such a failure is a property of the network path, not of the key
 * or the request, so retrying it on the same path only repeats the wait.
 *
 * `ETIMEDOUT` counts only when it happened during the connection phase; after
 * the socket is up, a timeout is a response-phase failure.
 *
 * @param error - the error thrown by `httpRequest` (or one wrapping it as `cause`).
 * @returns true for a connection-phase failure.
 */
export function isConnectFailure(error) {
  if (error === null || error === undefined) return false
  if (error.connectFailure === true) return true
  const phase = error.phase ?? error.cause?.phase
  const code = String(error.networkCode ?? error.code ?? error.cause?.code ?? '')
  if (phase === 'connect') return CONNECT_CODES.has(code) || code === 'ETIMEDOUT' || code === 'ECONNRESET'
  if (phase === 'response') return false
  return CONNECT_CODES.has(code)
}

/**
 * Tag an error with the phase it happened in and a code, without losing an
 * existing code.
 * @param error - the error.
 * @param phase - `connect` or `response`.
 * @param code - a code to set when the error has none.
 * @returns the same error.
 */
function tagError(error, phase, code = null) {
  const out = error instanceof Error ? error : new Error(String(error))
  if (out.phase === undefined) out.phase = phase
  if (code !== null && (out.code === undefined || out.code === null)) out.code = code
  return out
}

/**
 * Open `socket -> proxy -> CONNECT -> [TLS] -> origin`.
 *
 * Every failure before the tunnel is up is tagged `phase: 'connect'`, and those
 * at the proxy hop also `proxyHop: true`, so the caller can tell "the proxy port
 * refused" from "the origin refused" — `ECONNREFUSED 127.0.0.1:7897` on its own
 * reads like the latter.
 *
 * @param options - proxy URL, target host/port, whether to wrap in TLS, the
 *   server name to validate the certificate against, and an optional
 *   `deadline` signal that tears a half-open tunnel down.
 * @returns a promise of a socket that already speaks to the origin.
 */
function tunnel(options) {
  const { proxy, targetHost, targetPort, useTls, servername, deadline = null } = options
  const parsed = new URL(proxy)
  const proxyPort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)

  return new Promise((resolve, reject) => {
    let settled = false
    let socket = null
    let secured = null

    /** Detach the deadline listener once the outcome is known. */
    const cleanup = () => {
      if (deadline !== null) deadline.removeEventListener('abort', onDeadline)
    }
    /**
     * Report a failure exactly once and tear the sockets down.
     * @param error - the failure.
     */
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      secured?.destroy()
      socket?.destroy()
      reject(error)
    }
    /**
     * Hand over a ready socket exactly once.
     * @param ready - the socket the request layer will use.
     */
    const done = (ready) => {
      if (settled) return
      settled = true
      cleanup()
      // Marked so `httpRequest` knows the connection phase is already over.
      ready.naiTunnelReady = true
      resolve(ready)
    }
    /** The request's connect deadline fired, or the caller aborted. */
    function onDeadline() {
      const reason = deadline?.reason
      fail(reason instanceof Error ? reason : Object.assign(new Error('connection aborted'), { phase: 'connect' }))
    }
    if (deadline !== null) {
      if (deadline.aborted) {
        onDeadline()
        return
      }
      deadline.addEventListener('abort', onDeadline, { once: true })
    }

    try {
      socket = netConnect({ host: parsed.hostname, port: proxyPort })
    } catch (error) {
      fail(Object.assign(error, { phase: 'connect', proxyHop: true }))
      return
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      fail(Object.assign(new Error(`proxy CONNECT timed out after ${CONNECT_TIMEOUT_MS}ms`), { code: 'EPROXY_TIMEOUT', phase: 'connect', proxyHop: true }))
    )
    // Kept for the socket's whole life: once the tunnel is handed over, `fail` is
    // a no-op, and an error emitted with no listener at all would crash the host.
    socket.on('error', (error) => fail(Object.assign(error, { phase: 'connect', proxyHop: !secured })))

    socket.once('connect', () => {
      const lines = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`]
      if (parsed.username || parsed.password) {
        const raw = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(raw).toString('base64')}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })

    let buffered = Buffer.alloc(0)
    /**
     * Accumulate until the CONNECT response header is complete.
     * @param chunk - bytes from the proxy.
     */
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > MAX_PROXY_HEADER_BYTES) {
          fail(Object.assign(new Error('proxy sent an oversized CONNECT response'), { code: 'EPROXY_CONNECT', phase: 'connect', proxyHop: true }))
        }
        return
      }
      socket.removeListener('data', onData)
      socket.setTimeout(0)
      if (settled) return

      const head = buffered.subarray(0, end).toString('latin1')
      const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(head)?.[1] ?? 0)
      if (status !== 200) {
        fail(
          Object.assign(new Error(`proxy refused CONNECT (${head.split('\r\n')[0] || 'empty response'})`), {
            code: 'EPROXY_CONNECT',
            phase: 'connect',
            proxyHop: true
          })
        )
        return
      }
      // Anything the proxy sent after the header already belongs to the tunnel;
      // push it back so the layer above sees a clean stream.
      const rest = buffered.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)

      if (!useTls) {
        done(socket)
        return
      }
      secured = tlsConnect({ socket, servername: servername ?? targetHost })
      secured.once('secureConnect', () => done(secured))
      secured.on('error', (error) => fail(Object.assign(error, { phase: 'connect' })))
    }
    socket.on('data', onData)
  })
}

/**
 * Build an agent class that hands Node a tunnelled socket.
 * @param Base - `node:http`.Agent or `node:https`.Agent.
 * @param useTls - whether to layer TLS over the tunnel.
 * @returns the agent class.
 */
function makeTunnelAgent(Base, useTls) {
  return class TunnelAgent extends Base {
    /**
     * @param proxyUrl - the proxy to tunnel through.
     */
    constructor(proxyUrl) {
      super({ keepAlive: false })
      this.proxyUrl = proxyUrl
    }

    /**
     * Node's single extension point for custom transports.
     * @param options - Node's connection options for the origin; `naiDeadline`
     *   is passed through from `httpRequest`.
     * @param callback - `(error, socket)`.
     * @returns nothing.
     */
    createConnection(options, callback) {
      tunnel({
        proxy: this.proxyUrl,
        targetHost: options.host,
        targetPort: options.port ?? (useTls ? 443 : 80),
        useTls,
        servername: options.servername ?? options.host,
        deadline: options.naiDeadline ?? null
      }).then(
        (socket) => callback(null, socket),
        (error) => callback(error)
      )
    }
  }
}

const HttpsTunnelAgent = makeTunnelAgent(HttpsAgent, true)
const HttpTunnelAgent = makeTunnelAgent(HttpAgent, false)

/** Agents are cached per proxy URL; one agent per request would leak sockets. */
const agentCache = new Map()
/**
 * Resolve (and memoize) the agents for a proxy.
 * @param proxyUrl - the proxy URL.
 * @returns both protocol agents.
 */
function agentsFor(proxyUrl) {
  let pair = agentCache.get(proxyUrl)
  if (pair === undefined) {
    pair = { https: new HttpsTunnelAgent(proxyUrl), http: new HttpTunnelAgent(proxyUrl) }
    agentCache.set(proxyUrl, pair)
  }
  return pair
}

/**
 * Decide which proxy to use.
 *
 * Accepted forms mirror how the value reads in the panel:
 *   - `''` / `off` / `none` / `direct` — connect directly (the default: the
 *     usual setup reaches NovelAI through a relay base URL, which needs no proxy)
 *   - `auto` / `system` — use the detected Windows system proxy when there is one
 *   - anything else — used verbatim as the proxy URL
 *
 * @param value - the configured value.
 * @param detected - a system proxy detected by the caller, if any.
 * @returns the proxy URL to use, or `null` for a direct connection.
 */
export function resolveProxy(value, detected = null) {
  const raw = String(value ?? '').trim()
  const lower = raw.toLowerCase()
  if (raw === '' || lower === 'off' || lower === 'none' || lower === 'direct') return null
  if (lower === 'auto' || lower === 'system') return detected ?? null
  return raw
}

/**
 * Perform one HTTP(S) request and collect the whole body.
 *
 * `Accept-Encoding: identity` is sent unless the caller overrides it: nothing
 * here transparently decompresses, and the NovelAI endpoints answer with a zip,
 * so asking for no content coding keeps the bytes unambiguous.
 *
 * Two clocks, because the two phases fail differently:
 *
 *   - `connectTimeoutMs` covers DNS, TCP, the proxy's CONNECT and the TLS
 *     handshake. A route that silently drops packets hangs here, and only here,
 *     for as long as the OS lets it — minutes on Windows. Past the deadline the
 *     request fails with `code: 'ECONNECT_TIMEOUT'`.
 *   - `timeoutMs` is the idle timeout once connected: a render legitimately
 *     takes tens of seconds before the first byte comes back.
 *
 * Every failure is tagged `phase: 'connect'` or `phase: 'response'`, which is
 * what lets the key pool decide whether a retry could possibly help.
 *
 * Direct connections use a fresh socket per request (`agent: false`), so the
 * connection phase is always observable — a pooled keep-alive socket would skip
 * it, and with it the deadline.
 *
 * @param options - url, method, headers, body, proxy, timeouts and abort signal.
 * @returns `{ status, headers, body }`.
 */
export function httpRequest(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    body = null,
    proxy = null,
    timeoutMs = 120000,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    signal = null,
    maxBytes = MAX_RESPONSE_BYTES,
    /** Optional `({ received, total, headers }) => void`, called as bytes arrive. */
    onProgress = null
  } = options

  return new Promise((resolve, reject) => {
    let settled = false
    let connected = false
    /**
     * Reject exactly once, tagged with the phase the failure happened in.
     * @param error - the failure.
     */
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      reject(tagError(error, connected ? 'response' : 'connect'))
    }

    const target = new URL(url)
    const secure = target.protocol !== 'http:'
    const send = secure ? httpsRequestPlain : httpRequestPlain
    const agent = proxy === null ? false : (secure ? agentsFor(proxy).https : agentsFor(proxy).http)

    // Aborting this tears a half-built tunnel down; a direct socket is torn
    // down by destroying the request itself.
    const gate = new AbortController()
    const deadlineMs = Math.max(1, Number(connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS)
    const connectTimer = setTimeout(() => {
      if (connected || settled) return
      const error = Object.assign(new Error(`could not connect to ${target.host} within ${deadlineMs}ms`), {
        code: 'ECONNECT_TIMEOUT',
        phase: 'connect',
        ...(proxy === null ? {} : { proxyHop: true })
      })
      gate.abort(error)
      request.destroy(error)
    }, deadlineMs)
    // The deadline must never keep the host process alive on its own.
    if (typeof connectTimer.unref === 'function') connectTimer.unref()

    /** The connection phase is over: the deadline no longer applies. */
    const markConnected = () => {
      connected = true
      clearTimeout(connectTimer)
    }

    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: { 'Accept-Encoding': 'identity', ...headers },
        agent,
        // Read by the tunnel agent's `createConnection`.
        naiDeadline: gate.signal
      },
      (response) => {
        markConnected()
        const chunks = []
        let size = 0
        /** Report cumulative bytes; a throwing listener must never break the read. */
        const report = (headers = false) => {
          if (typeof onProgress !== 'function') return
          try {
            const declared = Number(response.headers['content-length'])
            onProgress({ received: size, total: Number.isFinite(declared) && declared >= 0 ? declared : null, headers })
          } catch {
            // A progress listener is informational; ignore its failure.
          }
        }
        report(true)
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBytes) {
            response.destroy()
            fail(new Error(`response exceeded ${maxBytes} bytes`))
            return
          }
          chunks.push(chunk)
          report(false)
        })
        response.on('end', () => {
          if (settled) return
          settled = true
          resolve({ status: Number(response.statusCode ?? 0), headers: response.headers, body: Buffer.concat(chunks) })
        })
        response.on('error', fail)
      }
    )

    request.on('socket', (socket) => {
      // A tunnelled socket arrives already connected (and secured).
      if (socket.naiTunnelReady === true) {
        markConnected()
        return
      }
      if (secure) {
        if (socket.connecting === false && socket._secureEstablished === true) markConnected()
        else socket.once('secureConnect', markConnected)
      } else if (socket.connecting === false) {
        markConnected()
      } else {
        socket.once('connect', markConnected)
      }
    })

    request.setTimeout(timeoutMs, () =>
      request.destroy(Object.assign(new Error(`request timed out after ${timeoutMs}ms`), { code: 'ERESPONSE_TIMEOUT' }))
    )
    request.on('error', fail)

    if (signal !== null && signal !== undefined) {
      /** The caller gave up: tear down whichever phase is running. */
      const onAbort = () => {
        const error = Object.assign(new Error('aborted'), { code: 'ABORT_ERR', aborted: true })
        gate.abort(error)
        request.destroy(error)
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (body !== null) request.write(body)
    request.end()
  })
}
