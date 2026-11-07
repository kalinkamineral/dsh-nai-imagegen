/**
 * dsh-nai-imagegen — the model DSH itself is configured with.
 *
 * Prompt writing and reference-image analysis need a language model. Rather
 * than keep a second endpoint, key and model list, this module calls the one
 * the user already set up in DSH, through the host's `llm` service.
 *
 * Three host services are used, all looked up at call time with `ctx.get` so the
 * plugin still loads (and keeps rendering images) on a host without them:
 *
 *   - `llm`                `stream(options)` → AsyncIterable of chunks,
 *                          `resolveModelInfo`, `listProviders`, `listModels`
 *   - `agentDefaultModel`  `currentSelection()` → { provider, model }
 *   - `attachments`        `saveImage({ data, mediaType, name })` → image ref
 *
 * No host package is imported: a message is a plain object, and the stream is
 * assembled here. Errors from the provider do not throw inside the stream; they
 * arrive as a final `finish` chunk, which is turned into an Error below.
 */
import { randomUUID } from 'node:crypto'

/** Image types the host's attachment store accepts. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * The route to call: the plugin's own choice when both halves are set,
 * otherwise DSH's default model.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration (`llmProvider`, `llmModel`).
 * @returns `{ provider, model, source }` or `null` when nothing is configured.
 */
export function selectedRoute(ctx, config = {}) {
  const provider = String(config.llmProvider ?? '').trim()
  const model = String(config.llmModel ?? '').trim()
  if (provider !== '' && model !== '') return { provider, model, source: 'plugin' }
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model, source: 'dsh-default' }
  } catch {
    // An inactive service reads as "no default".
  }
  return null
}

/**
 * Whether one route accepts image input, per the host's model metadata.
 * @param llm - the host `llm` service.
 * @param route - `{ provider, model }`.
 * @returns true, false, or null when the host could not say.
 */
async function routeSeesImages(llm, route) {
  if (typeof llm?.resolveModelInfo !== 'function') return null
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    return Array.isArray(info?.inputModalities) ? info.inputModalities.includes('image') : false
  } catch {
    return null
  }
}

/**
 * What the panel needs to know before offering LLM features.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 * @returns availability, the route in force, and whether it takes images.
 */
export async function llmStatus(ctx, config = {}) {
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') return { available: false, reason: 'DSH 的模型服务不可用' }
  const route = selectedRoute(ctx, config)
  if (route === null) return { available: false, reason: 'DSH 里还没有设置默认模型' }
  return {
    available: true,
    provider: route.provider,
    model: route.model,
    source: route.source,
    vision: await routeSeesImages(llm, route),
    attachments: typeof ctx.get?.('attachments')?.saveImage === 'function'
  }
}

/**
 * The models DSH knows, for the panel's model picker.
 * @param ctx - the plugin context.
 * @returns `[{ provider, label, models: [{ id, name, vision }] }]`; empty when unavailable.
 */
export async function llmModels(ctx) {
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.listProviders !== 'function') return []
  let providers = []
  try {
    providers = await llm.listProviders()
  } catch {
    return []
  }
  const out = []
  for (const row of Array.isArray(providers) ? providers : []) {
    const provider = String(row?.provider ?? row?.id ?? '')
    if (provider === '') continue
    let models = []
    try {
      models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : []
    } catch {
      models = []
    }
    out.push({
      provider,
      label: String(row?.displayName ?? row?.name ?? provider),
      models: (Array.isArray(models) ? models : []).map((m) => ({
        id: String(m?.id ?? ''),
        name: String(m?.name ?? m?.id ?? ''),
        vision: Array.isArray(m?.inputModalities) ? m.inputModalities.includes('image') : false
      })).filter((m) => m.id !== '')
    })
  }
  return out
}

/**
 * Decode a base64 data URL into bytes and a media type.
 * @param dataUrl - `data:image/…;base64,…`.
 * @returns `{ mediaType, data }`.
 */
export function decodeImageDataUrl(dataUrl) {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl ?? ''))
  if (match === null) throw new Error('参考图必须是 base64 图片')
  const mediaType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase()
  if (!IMAGE_TYPES.includes(mediaType)) throw new Error(`不支持的图片格式 ${mediaType}`)
  return { mediaType, data: new Uint8Array(Buffer.from(match[2].replace(/\s+/g, ''), 'base64')) }
}

/**
 * One completion against the configured model.
 *
 * @param ctx - the plugin context.
 * @param options - `system`, `prompt`, optional `images` (data URLs), optional
 *   `maxTokens`, `temperature`, `timeoutMs`, `signal`; `config` for the route.
 * @returns `{ text, provider, model, usage, truncated, finishKind }`.
 */
export async function complete(ctx, options) {
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 的模型服务不可用，无法写提示词')
  const route = selectedRoute(ctx, options.config ?? {})
  if (route === null) throw new Error('DSH 里还没有设置默认模型，或插件里只填了提供方和模型中的一项')

  const content = [{ type: 'text', text: String(options.prompt ?? '') }]
  const images = (options.images ?? []).filter((url) => typeof url === 'string' && url !== '')
  if (images.length > 0) {
    const sees = await routeSeesImages(llm, route)
    if (sees === false) {
      throw new Error(
        `当前模型 ${route.provider}/${route.model} 没有声明图片输入，DSH 会把图片换成占位文字。` +
          '请在插件设置里换一个支持图片的模型，或在 DSH 模型设置里给它加上 image 输入。'
      )
    }
    const attachments = ctx.get?.('attachments')
    if (typeof attachments?.saveImage !== 'function') throw new Error('DSH 的附件服务不可用，无法发送图片')
    for (const [index, url] of images.entries()) {
      const { mediaType, data } = decodeImageDataUrl(url)
      const ref = await attachments.saveImage({ data, mediaType, name: `nai-reference-${index + 1}` })
      content.push({ type: 'image', attachment: ref })
    }
  }

  const timeout = AbortSignal.timeout(Math.max(5000, Number(options.timeoutMs) || 180000))
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const request = {
    provider: route.provider,
    model: route.model,
    messages: [{ id: randomUUID(), role: 'user', content, source: { kind: 'user' } }],
    ...(options.system ? { system: String(options.system) } : {}),
    ...(Number(options.maxTokens) > 0 ? { maxTokens: Number(options.maxTokens) } : {}),
    ...(Number.isFinite(options.temperature) ? { temperature: Number(options.temperature) } : {}),
    signal
  }

  const parts = new Map()
  let finish = null
  let usage = null
  for await (const chunk of llm.stream(request)) {
    if (chunk?.type === 'text-delta') parts.set(chunk.index, (parts.get(chunk.index) ?? '') + String(chunk.text ?? ''))
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') parts.set(chunk.index, String(chunk.block.text ?? ''))
    else if (chunk?.type === 'usage') usage = chunk.usage ?? null
    else if (chunk?.type === 'finish') finish = chunk.reason ?? null
  }
  // `finishKind` and `usage` travel with the result and with every error, so the
  // debug log can show how a call ended even when it produced nothing usable.
  const finishKind = finish?.kind ?? null
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    const error = new Error(
      finish.kind === 'aborted' && timeout.aborted
        ? '模型超时没有返回'
        : String(finish.failure?.message || finish.failure?.code || '模型调用失败')
    )
    error.code = finish.failure?.code
    Object.assign(error, { finishKind, usage, provider: route.provider, model: route.model })
    throw error
  }
  const text = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part).join('').trim()
  if (text === '') {
    throw Object.assign(new Error(`模型没有返回文字（结束原因：${finish?.kind ?? '无'}）`), {
      finishKind,
      usage,
      provider: route.provider,
      model: route.model
    })
  }
  return { text, provider: route.provider, model: route.model, usage, truncated: finish?.kind === 'max-tokens', finishKind }
}

/**
 * Pull the first JSON object out of a model reply: a fenced block, or the
 * outermost braces.
 * @param text - the model's reply.
 * @returns the parsed object, or `null`.
 */
export function extractJson(text) {
  const raw = String(text ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value !== null && typeof value === 'object') return value
    } catch {
      // try the next candidate
    }
  }
  return null
}
