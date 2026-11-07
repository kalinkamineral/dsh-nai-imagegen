/**
 * dsh-nai-imagegen — a pool of NovelAI API keys with real concurrency.
 *
 * Ported from the reference implementation this project was asked to follow
 * (`奶龙工具箱/local-apps/novelai-webui/server.js`, `class KeyPool`), keeping its
 * behaviour and dropping what this plugin does not need.
 *
 * The concurrency model is the whole point, and it falls out of one line:
 * `candidates()` only ever returns keys whose `active` flag is clear, and
 * `pump()` keeps dispatching while the queue is non-empty. So **the number of
 * in-flight requests equals the number of usable keys** — four keys, four
 * simultaneous renders — with least-recently-used rotation deciding which key
 * takes the next job.
 *
 * Failure handling, also from the reference:
 *
 *   - `401` / `403` disable the key (`invalid` / `forbidden`) and the job moves
 *     to another key if one exists — a dead key must not consume a slot.
 *   - `429` puts the key in `cooldown` with exponential backoff (honouring
 *     `Retry-After` when the caller surfaces it) and the job is re-queued
 *     **avoiding that key**.
 *   - `408`, `5xx` and network errors after a connection was made do the same
 *     with a shorter backoff.
 *   - a failure to connect at all (lib/net.js `isConnectFailure`) is not
 *     retried: the job fails at once, and so does everything queued behind it.
 *   - anything else rejects the job and marks the key `unverified`.
 *
 * Secrets stay here: `list()` returns labels and fingerprints, never tokens, so
 * the browser half can render key management without ever holding a credential.
 */
import { createHash, randomUUID } from 'node:crypto'
import { isConnectFailure } from './net.js'

/** Longest label accepted, matching the reference's clamp. */
const MAX_LABEL = 60
/** Backoff ceiling for a cooled-down key. */
const MAX_COOLDOWN_MS = 60000

/**
 * A stable, non-reversible identifier for a token.
 * @param token - the API key.
 * @returns ten hexadecimal characters.
 */
export function fingerprintOf(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 10)
}

/**
 * Trim a label, falling back to a fingerprint-derived one when the caller
 * supplied a token by mistake.
 * @param label - the requested label.
 * @param fingerprint - the key's fingerprint.
 * @returns a display label.
 */
function normalizeLabel(label, fingerprint) {
  const text = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)
  if (text === '' || /^pst-/i.test(text)) return `Key ${fingerprint.slice(0, 6)}`
  return text
}

export class KeyPool {
  /**
   * @param options - the call implementation and the clock (both injectable so
   *   the pool is testable without a network or real time).
   */
  constructor(options = {}) {
    /** @type {Map<string, object>} */
    this.keys = new Map()
    /** @type {Array<object>} */
    this.queue = []
    this.activeTasks = new Set()
    this.timer = null
    this.call = options.call
    if (typeof this.call !== 'function') throw new Error('KeyPool requires a call(payload, token, signal) implementation')
    this.now = options.now ?? Date.now
  }

  /** How many jobs may run at once: one per usable key. */
  get concurrency() {
    return Math.max(1, this.enabledCount())
  }

  /**
   * Register a key. Duplicates are recognised by fingerprint and returned as-is.
   * @param options - label, token and initial enabled state.
   * @returns the internal key record.
   */
  addKey({ label = '', token, enabled = true, id = null } = {}) {
    const value = String(token ?? '').trim()
    if (value === '') throw new Error('token is required')
    const fingerprint = fingerprintOf(value)
    for (const existing of this.keys.values()) {
      if (existing.fingerprint === fingerprint) {
        // Re-adding a known key refreshes its label rather than duplicating it.
        if (label) existing.label = normalizeLabel(label, fingerprint)
        if (typeof id === 'string' && id !== '') existing.id = id
        return existing
      }
    }
    const key = {
      // Adopt the configured id when there is one, so the host's persisted key
      // list and the pool address the same key by the same name.
      id: typeof id === 'string' && id !== '' ? id : randomUUID(),
      label: normalizeLabel(label, fingerprint),
      token: value,
      fingerprint,
      enabled: enabled === true,
      active: false,
      status: enabled === true ? 'unverified' : 'disabled',
      cooldownUntil: 0,
      failures: 0,
      completed: 0,
      lastUsed: 0,
      subscription: null,
      lastError: '',
      lastErrorCode: 0,
      lastErrorAt: 0
    }
    this.keys.set(key.id, key)
    this.pump()
    return key
  }

  /**
   * The browser-safe view of one key. The token is deliberately absent.
   * @param key - the internal record.
   * @returns the public projection.
   */
  publicKey(key) {
    return {
      id: key.id,
      label: key.label,
      fingerprint: key.fingerprint,
      enabled: key.enabled,
      active: key.active,
      status: key.status,
      cooldownUntil: key.cooldownUntil,
      failures: key.failures,
      completed: key.completed,
      lastUsed: key.lastUsed,
      subscription: key.subscription,
      lastError: key.lastError,
      lastErrorCode: key.lastErrorCode,
      lastErrorAt: key.lastErrorAt
    }
  }

  /** Release keys whose cooldown has elapsed. */
  refreshCooldowns() {
    for (const key of this.keys.values()) {
      if (key.status !== 'cooldown' || key.active || key.cooldownUntil > this.now()) continue
      key.cooldownUntil = 0
      key.status = key.enabled ? 'healthy' : 'disabled'
    }
  }

  /**
   * Record why a key failed, in terms the panel can show.
   * @param key - the key.
   * @param error - the failure.
   */
  recordFailure(key, error) {
    const status = Number(error?.statusCode) || 0
    const network = status === 0
    const code = String(error?.code ?? error?.cause?.code ?? 'NETWORK_ERROR')
    key.lastErrorCode = status
    key.lastErrorAt = this.now()
    key.lastError = network
      ? `网络连接失败（${/^[A-Z0-9_]+$/.test(code) ? code : 'NETWORK_ERROR'}），检查接口地址或代理。`
      : status === 429
        ? 'NovelAI 限流，冷却后可重试。'
        : status === 402
          ? 'NovelAI 额度不足。'
          : [408, 504].includes(status)
            ? 'NovelAI 请求超时，可稍后重试。'
            : `NovelAI 请求失败（HTTP ${status}）。`
  }

  /** @returns the public projection of every key. */
  list() {
    this.refreshCooldowns()
    return [...this.keys.values()].map((key) => this.publicKey(key))
  }

  /**
   * Whether a key may still be dispatched to.
   * @param key - the key.
   * @returns true when usable.
   */
  usable(key) {
    return key.enabled && !['invalid', 'forbidden'].includes(key.status)
  }

  /** @returns true when at least one key is usable. */
  configured() {
    return [...this.keys.values()].some((key) => this.usable(key))
  }

  /** @returns how many keys are usable. */
  enabledCount() {
    return [...this.keys.values()].filter((key) => this.usable(key)).length
  }

  /** @returns how many keys are usable and idle right now. */
  availableCount() {
    const now = this.now()
    return [...this.keys.values()].filter((key) => this.usable(key) && !key.active && key.cooldownUntil <= now).length
  }

  /**
   * How many times one job may be retried across keys.
   *
   * Prefers untried keys while keeping a small cap, so a malformed request
   * cannot keep the shared queue busy forever.
   * @returns the attempt ceiling.
   */
  retryLimit() {
    return Math.max(3, Math.min(6, this.enabledCount() + 1))
  }

  /** @returns a summary for the panel's header. */
  healthSummary() {
    const keys = this.list()
    const issues = keys
      .filter((key) => ['invalid', 'forbidden'].includes(key.status) || key.lastErrorCode >= 400)
      .map((key) => ({ id: key.id, label: key.label, status: key.status, errorCode: key.lastErrorCode, error: key.lastError }))
    return {
      keyCount: keys.length,
      enabledKeyCount: keys.filter((key) => key.enabled).length,
      usableKeyCount: this.enabledCount(),
      availableKeyCount: this.availableCount(),
      concurrency: this.concurrency,
      queuedCount: this.queue.length,
      activeCount: this.activeTasks.size,
      problemKeyCount: issues.length,
      keyIssues: issues
    }
  }

  /**
   * Update a key's label or enabled flag.
   * @param id - the key id.
   * @param patch - `{ label, enabled }`.
   * @returns the updated public projection.
   */
  updateKey(id, patch = {}) {
    const key = this.keys.get(id)
    if (key === undefined) throw new Error('unknown key')
    if (patch.enabled === true && ['invalid', 'forbidden'].includes(key.status)) {
      throw new Error('a key marked invalid or forbidden must be re-verified before it can be enabled')
    }
    if (typeof patch.label === 'string' && patch.label.trim() !== '') {
      key.label = normalizeLabel(patch.label, key.fingerprint)
    }
    if (typeof patch.enabled === 'boolean') key.enabled = patch.enabled
    key.status = key.enabled ? (key.status === 'disabled' ? 'healthy' : key.status) : 'disabled'
    this.pump()
    return this.publicKey(key)
  }

  /**
   * Forget a key.
   * @param id - the key id.
   * @returns whether it existed.
   */
  removeKey(id) {
    const removed = this.keys.delete(id)
    this.rejectQueuedWithoutKeys()
    this.pump()
    return removed
  }

  /** Drop every key and stop the timer. */
  clear() {
    this.keys.clear()
    this.rejectQueuedWithoutKeys()
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Reject everything still queued when no usable key remains. */
  rejectQueuedWithoutKeys() {
    if (this.configured()) return
    const error = Object.assign(new Error('没有可用的 NovelAI API Key，队列已停止。'), { statusCode: 401 })
    this.queue.splice(0).forEach((task) => task.reject(error))
  }

  /**
   * Queue one job.
   * @param payload - whatever `call` needs.
   * @param options - optional external abort signal.
   * @returns a promise for the job's result.
   */
  enqueue(payload, options = {}) {
    if (!this.configured()) {
      return Promise.reject(Object.assign(new Error('请先在侧栏配置至少一个可用的 NovelAI API Key。'), { statusCode: 401 }))
    }
    return new Promise((resolve, reject) => {
      const task = {
        payload,
        resolve,
        reject,
        attempts: 0,
        attemptedKeyIds: new Set(),
        avoidKeyId: null,
        // A verification run wants one honest report per key, so it must not be
        // silently moved to a different key when one fails.
        noRetry: options.noRetry === true,
        controller: new AbortController()
      }
      if (options.signal !== undefined && options.signal !== null) {
        if (options.signal.aborted) {
          reject(Object.assign(new Error('aborted'), { statusCode: 499 }))
          return
        }
        options.signal.addEventListener(
          'abort',
          () => {
            // A job that has not started leaves the queue at once; a running one
            // is aborted and rejected by `run` when its call returns.
            const at = this.queue.indexOf(task)
            if (at >= 0) {
              this.queue.splice(at, 1)
              task.reject(Object.assign(new Error('aborted'), { statusCode: 499 }))
            }
            task.controller.abort()
          },
          { once: true }
        )
      }
      this.queue.push(task)
      this.pump()
    })
  }

  /**
   * Call one key directly, outside the render queue.
   *
   * For reads that must not wait behind renders — a connectivity probe, a key
   * verification, a balance read. They take no render slot, so a render stuck
   * on a dead route cannot hold them up, and they do not delay renders either.
   * Key bookkeeping (status, last error, subscription) is updated as for a job.
   *
   * @param payload - whatever `call` needs.
   * @param options - `{ keyId?, signal? }`; without `keyId` the least recently
   *   used usable key is taken.
   * @returns the call's result.
   */
  async bypass(payload, options = {}) {
    const key =
      options.keyId !== undefined && options.keyId !== null
        ? this.keys.get(options.keyId)
        : [...this.keys.values()].filter((row) => this.usable(row)).sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (key === undefined) {
      throw Object.assign(new Error('请先在侧栏配置至少一个可用的 NovelAI API Key。'), { statusCode: 401 })
    }
    const controller = new AbortController()
    if (options.signal) {
      if (options.signal.aborted) throw Object.assign(new Error('aborted'), { statusCode: 499 })
      options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const result = await this.call(payload, key.token, controller.signal)
      if (result !== null && typeof result === 'object' && result.subscription !== undefined && result.subscription !== null) {
        key.subscription = result.subscription
      }
      // A key marked invalid/forbidden that now answers is re-verified: it may be
      // switched back on (it stays off until the user does so).
      if (['invalid', 'forbidden'].includes(key.status)) key.status = key.enabled ? 'healthy' : 'disabled'
      else if (key.enabled && ['unverified', 'cooldown'].includes(key.status) && !(key.cooldownUntil > this.now())) key.status = 'healthy'
      key.lastError = ''
      key.lastErrorCode = 0
      key.lastErrorAt = 0
      return result
    } catch (error) {
      const status = Number(error?.statusCode) || 0
      if (!controller.signal.aborted && status !== 499) {
        Object.assign(error, { keyId: key.id, keyLabel: key.label, keyFingerprint: key.fingerprint })
        this.recordFailure(key, error)
        if (status === 401 || status === 403) {
          key.enabled = false
          key.status = status === 403 ? 'forbidden' : 'invalid'
          key.lastError = status === 403 ? 'NovelAI 拒绝访问：该 Key 可能没有生图权限或订阅异常。' : 'NovelAI API Key 无效或已过期。'
          this.rejectQueuedWithoutKeys()
        }
      }
      throw error
    }
  }

  /**
   * Fail every job still waiting, with the cause that just stopped one.
   *
   * Used for connection-phase failures: every key here shares the plugin's one
   * network path (same base URL, same proxy), so a route that could not connect
   * for one job cannot connect for the next, and letting each one wait out its
   * own deadline turns one dead route into minutes of "出图中…".
   *
   * @param cause - the failure.
   */
  failQueued(cause) {
    const pending = this.queue.splice(0)
    for (const task of pending) {
      task.reject(
        Object.assign(new Error(cause.message), {
          code: cause.code,
          networkCode: cause.networkCode,
          statusCode: 0,
          connectFailure: true,
          queued: true,
          hint: cause.hint
        })
      )
    }
  }

  /**
   * Idle keys that could take this job, least-recently-used first.
   * @param task - the job, or null for an undirected query.
   * @returns candidate keys.
   */
  candidates(task = null) {
    const now = this.now()
    const ready = [...this.keys.values()]
      .filter((key) => this.usable(key) && !key.active && key.cooldownUntil <= now)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    if (task === null) return ready
    const hasOther = task.avoidKeyId !== null && [...this.keys.values()].some((key) => key.id !== task.avoidKeyId && this.usable(key))
    const preferred = hasOther ? ready.filter((key) => key.id !== task.avoidKeyId) : ready
    const untried = preferred.filter((key) => !task.attemptedKeyIds.has(key.id))
    return untried.length > 0 ? untried : preferred
  }

  /** Arm a timer for the earliest cooldown expiry, so the queue drains itself. */
  scheduleWake() {
    if (this.timer !== null) clearTimeout(this.timer)
    const now = this.now()
    const next = Math.min(
      ...[...this.keys.values()].filter((key) => key.enabled && key.cooldownUntil > now).map((key) => key.cooldownUntil)
    )
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.pump()
      }, Math.max(10, next - now))
      // A pending wake must never hold the host process open.
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
  }

  /** Dispatch as many queued jobs as there are idle keys. */
  pump() {
    this.refreshCooldowns()
    while (this.queue.length > 0) {
      const task = this.queue[0]
      const key = this.candidates(task)[0]
      if (key === undefined) {
        this.scheduleWake()
        return
      }
      this.queue.shift()
      this.run(key, task)
    }
  }

  /**
   * Run one job on one key and classify the outcome.
   * @param key - the key to use.
   * @param task - the job.
   */
  async run(key, task) {
    key.active = true
    key.lastUsed = this.now()
    this.activeTasks.add(task)
    try {
      const result = await this.call(task.payload, key.token, task.controller.signal)
      key.failures = 0
      key.completed += 1
      key.status = 'healthy'
      // A probe reports the subscription; keeping it is what lets the panel show
      // each key's tier and remaining training steps. Discarding the result here
      // left every key with an empty tier even right after verifying.
      if (result !== null && typeof result === 'object' && result.subscription !== undefined && result.subscription !== null) {
        key.subscription = result.subscription
      }
      key.lastError = ''
      key.lastErrorCode = 0
      key.lastErrorAt = 0
      task.resolve(result)
    } catch (error) {
      const status = Number(error?.statusCode) || 0
      const aborted = status === 499 || task.controller.signal.aborted
      if (!aborted) {
        Object.assign(error, { keyId: key.id, keyLabel: key.label, keyFingerprint: key.fingerprint })
        this.recordFailure(key, error)
      }
      if (aborted) {
        task.reject(Object.assign(new Error('aborted'), { statusCode: 499 }))
      } else if (status === 0 && isConnectFailure(error)) {
        // Never got a connection. Not the key's fault (no cooldown, no penalty),
        // and every key shares the same route, so neither this key nor another
        // would do better: fail this job and everything queued behind it now.
        task.reject(error)
        this.failQueued(error)
      } else if (status === 401 || status === 403) {
        key.failures += 1
        key.enabled = false
        key.status = status === 403 ? 'forbidden' : 'invalid'
        key.lastError =
          status === 403
            ? 'NovelAI 拒绝访问：该 Key 可能没有生图权限或订阅异常。'
            : 'NovelAI API Key 无效或已过期。'
        const hasOther = [...this.keys.values()].some((candidate) => candidate.id !== key.id && this.usable(candidate))
        if (hasOther && !task.noRetry) {
          task.attempts += 1
          task.attemptedKeyIds.add(key.id)
          task.avoidKeyId = key.id
          this.queue.unshift(task)
        } else {
          task.reject(error)
        }
      } else if (status === 429 && !task.noRetry && task.attempts < this.retryLimit()) {
        const backoff = Math.min(MAX_COOLDOWN_MS, 2000 * 2 ** task.attempts) + Math.floor(Math.random() * 500)
        key.cooldownUntil = this.now() + (error.retryAfterMs || backoff)
        key.status = 'cooldown'
        task.attempts += 1
        task.attemptedKeyIds.add(key.id)
        task.avoidKeyId = key.id
        this.queue.push(task)
        key.failures += 1
      } else if ((status === 408 || status >= 500 || status === 0) && !task.noRetry && task.attempts < this.retryLimit()) {
        key.cooldownUntil = this.now() + 1000 * 2 ** task.attempts
        key.status = 'cooldown'
        task.attempts += 1
        task.attemptedKeyIds.add(key.id)
        task.avoidKeyId = key.id
        this.queue.push(task)
        key.failures += 1
      } else {
        key.status = 'unverified'
        task.reject(error)
        key.failures += 1
      }
    } finally {
      this.activeTasks.delete(task)
      key.active = false
      this.pump()
    }
  }
}

/**
 * Build a pool from the plugin configuration.
 *
 * The single `token` field is kept working as the first key so an existing
 * config keeps rendering; `keys` is the managed list the panel edits.
 *
 * @param config - the loaded configuration.
 * @param options - the call implementation and clock.
 * @returns the pool.
 */
export function createPool(config, options) {
  const pool = new KeyPool(options)
  const legacy = String(config?.token ?? '').trim()
  if (legacy !== '') pool.addKey({ label: '主 Key（配置里的单一 token）', token: legacy })
  for (const entry of config?.keys ?? []) {
    const token = String(typeof entry === 'string' ? entry : entry?.token ?? '').trim()
    if (token === '') continue
    pool.addKey({
      label: String(typeof entry === 'string' ? '' : entry?.label ?? ''),
      token,
      enabled: typeof entry === 'object' && entry !== null ? entry.enabled !== false : true,
      id: typeof entry === 'object' && entry !== null ? entry.id ?? null : null
    })
  }
  return pool
}
