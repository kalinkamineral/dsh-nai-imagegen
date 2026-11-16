/**
 * dsh-nai-imagegen — read the generation record NovelAI stores inside its PNGs.
 *
 * A NovelAI render carries its whole request twice:
 *
 *   1. As PNG text chunks — `Software`, `Source` (model name + hash),
 *      `Description` (the prompt) and `Comment`, a JSON object holding every
 *      parameter the server actually used: seed, sampler, steps, scale,
 *      cfg_rescale, the structured `v4_prompt` / `v4_negative_prompt` captions
 *      with character centres, and the sampler flags
 *      (`prefer_brownian`, `deliberate_euler_ancestral_bug`, …).
 *   2. Hidden in the alpha channel's least significant bits ("stealth pnginfo",
 *      signature `stealth_pngcomp`, gzip). This copy survives tools and sites
 *      that strip text chunks but keep the pixels.
 *
 * This module reads both, prefers the text chunks, and turns the record into
 * two things: a workbench caption (scene + characters, for editing) and a replay
 * request (every sampling field, for an exact re-render). Dependency-free: only
 * `node:zlib`.
 */
import { gunzipSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const STEALTH_COMPRESSED = 'stealth_pngcomp'
const STEALTH_PLAIN = 'stealth_pnginfo'

/** Whether a buffer starts with the PNG signature. */
export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

/**
 * Walk the chunks of a PNG.
 * @param png - the file bytes.
 * @returns `{ ihdr, text, idat }`: header fields, the text chunks decoded as
 *   UTF-8 (falling back to latin1), and the concatenated image data.
 */
export function readChunks(png) {
  if (!isPng(png)) throw new Error('不是 PNG 文件')
  const text = {}
  const idat = []
  let ihdr = null
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    if (offset + 12 + length > png.length) break
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      try {
        const entry = textChunk(type, data)
        if (entry !== null) text[entry.key] = entry.value
      } catch {
        // A damaged chunk only costs that one field.
      }
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  return { ihdr, text, idat }
}

/** Decode UTF-8 strictly, else latin1 — NovelAI writes UTF-8 into tEXt. */
function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return Buffer.from(bytes).toString('latin1')
  }
}

function textChunk(type, data) {
  const nul = data.indexOf(0)
  if (nul <= 0) return null
  const key = data.toString('latin1', 0, nul)
  if (type === 'tEXt') return { key, value: decodeText(data.subarray(nul + 1)) }
  if (type === 'zTXt') return { key, value: decodeText(inflateSync(data.subarray(nul + 2))) }
  // iTXt: keyword \0 flag method language \0 translated \0 text
  const flag = data[nul + 1]
  const languageEnd = data.indexOf(0, nul + 3)
  const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1)
  if (translatedEnd < 0) return null
  const raw = data.subarray(translatedEnd + 1)
  return { key, value: decodeText(flag === 1 ? inflateSync(raw) : raw) }
}

/**
 * Undo PNG scanline filtering.
 * @returns the raw pixel bytes, `height * width * bpp`.
 */
function unfilter(inflated, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let src = 0
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src]
    src += 1
    const row = y * stride
    const prev = row - stride
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[src + x]
      const left = x >= bpp ? out[row + x - bpp] : 0
      const up = y > 0 ? out[prev + x] : 0
      const upLeft = y > 0 && x >= bpp ? out[prev + x - bpp] : 0
      let value
      switch (filter) {
        case 0:
          value = raw
          break
        case 1:
          value = raw + left
          break
        case 2:
          value = raw + up
          break
        case 3:
          value = raw + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default:
          throw new Error(`未知的 PNG 滤波类型 ${filter}`)
      }
      out[row + x] = value & 0xff
    }
    src += stride
  }
  return out
}

/**
 * Read the stealth copy from the alpha channel.
 *
 * Bits are read column by column (x outer, y inner), most significant first:
 * 15 bytes of signature, a 32-bit payload length in bits, then the payload —
 * gzip for `stealth_pngcomp`, plain UTF-8 for `stealth_pnginfo`.
 *
 * @param png - the file bytes.
 * @returns the decoded text, or `null` when the image carries none.
 */
export function readStealth(png) {
  const { ihdr, idat } = readChunks(png)
  // Only 8-bit, non-interlaced RGBA — what NovelAI writes.
  if (ihdr === null || ihdr.colorType !== 6 || ihdr.bitDepth !== 8 || ihdr.interlace !== 0 || idat.length === 0) return null
  const { width, height } = ihdr
  let pixels
  try {
    pixels = unfilter(inflateSync(Buffer.concat(idat)), width, height, 4)
  } catch {
    return null
  }
  const total = width * height
  let cursor = 0
  const bit = () => {
    if (cursor >= total) throw new RangeError('stealth payload runs past the image')
    const x = Math.floor(cursor / height)
    const y = cursor % height
    cursor += 1
    return pixels[(y * width + x) * 4 + 3] & 1
  }
  const bytes = (count) => {
    const out = Buffer.alloc(count)
    for (let i = 0; i < count; i += 1) {
      let value = 0
      for (let b = 0; b < 8; b += 1) value = (value << 1) | bit()
      out[i] = value
    }
    return out
  }
  try {
    const signature = bytes(STEALTH_COMPRESSED.length).toString('latin1')
    if (signature !== STEALTH_COMPRESSED && signature !== STEALTH_PLAIN) return null
    let lengthBits = 0
    for (let b = 0; b < 32; b += 1) lengthBits = lengthBits * 2 + bit()
    if (lengthBits <= 0 || lengthBits % 8 !== 0 || lengthBits / 8 > total) return null
    const payload = bytes(lengthBits / 8)
    return decodeText(signature === STEALTH_COMPRESSED ? gunzipSync(payload) : payload)
  } catch {
    return null
  }
}

/**
 * The model id behind a `Source` field such as `NovelAI Diffusion V5 0ADF9AB7`.
 *
 * Only hashes seen on real images are listed; any other source falls back to its
 * family's full model, and `exact` says so.
 */
const MODEL_HASHES = Object.freeze({
  '0ADF9AB7': 'nai-diffusion-5-full',
  '4BDE2A90': 'nai-diffusion-4-5-full'
})

export function modelFromSource(source) {
  const text = String(source ?? '')
  const hash = /\b([0-9A-F]{8})\s*$/i.exec(text)?.[1]?.toUpperCase() ?? null
  if (hash !== null && MODEL_HASHES[hash] !== undefined) return { model: MODEL_HASHES[hash], exact: true, hash }
  const curated = /curated/i.test(text)
  const furry = /furry/i.test(text)
  let model = null
  if (/V5\b/i.test(text)) model = curated ? 'nai-diffusion-5-curated' : 'nai-diffusion-5-full'
  else if (/V4\.5/i.test(text)) model = curated ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full'
  else if (/V4\b/i.test(text)) model = curated ? 'nai-diffusion-4-curated-preview' : 'nai-diffusion-4-full'
  else if (/V3\b/i.test(text)) model = furry ? 'nai-diffusion-furry-3' : 'nai-diffusion-3'
  return { model, exact: false, hash }
}

const finite = (value) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null)

/** `{x,y}` in 0..1, or null. */
function pointOf(value) {
  if (value === null || typeof value !== 'object') return null
  const x = finite(value.x)
  const y = finite(value.y)
  if (x === null || y === null) return null
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}

/**
 * Read everything a NovelAI PNG says about how it was made.
 *
 * @param png - the file bytes.
 * @returns `{ ok, origin, software, source, model, modelExact, caption, params, replay, notes }`
 *   where `caption` is the workbench shape and `replay` the exact request.
 */
export function readNaiImage(png) {
  if (!isPng(png)) {
    return { ok: false, reason: '不是 PNG 文件。NovelAI 的提示词只存在原始 PNG 里；JPEG / WebP 或被聊天软件压缩过的图已经丢失了这部分数据。' }
  }
  const { ihdr, text } = readChunks(png)
  let fields = text
  let origin = 'text'
  if (typeof fields.Comment !== 'string') {
    const hidden = readStealth(png)
    if (hidden !== null) {
      try {
        const parsed = JSON.parse(hidden)
        // The stealth copy holds the same fields as the text chunks; the Comment
        // may arrive as a string or already as an object.
        fields = { ...parsed, Comment: typeof parsed.Comment === 'string' ? parsed.Comment : JSON.stringify(parsed.Comment ?? parsed) }
        origin = 'stealth'
      } catch {
        fields = { Description: hidden }
        origin = 'stealth'
      }
    }
  }
  let comment = null
  if (typeof fields.Comment === 'string') {
    try {
      comment = JSON.parse(fields.Comment)
    } catch {
      comment = null
    }
  }
  if (comment === null || typeof comment !== 'object') {
    const hasText = typeof fields.Description === 'string' && fields.Description.trim() !== ''
    return {
      ok: false,
      reason: hasText
        ? '图片只带了提示词文本，没有 NovelAI 的参数记录（Comment），无法复现。'
        : '图片里没有 NovelAI 的生成记录。可能不是 NovelAI 出的图，或被重新编码过（截图、压缩、转格式都会清掉）。',
      description: hasText ? fields.Description : null,
      width: ihdr?.width ?? null,
      height: ihdr?.height ?? null
    }
  }

  const notes = []
  const source = String(fields.Source ?? '')
  const fromSource = modelFromSource(source)
  if (fromSource.model === null) notes.push(`不认识的模型来源「${source || '空'}」，复现时需要手动指定模型`)
  else if (!fromSource.exact) notes.push(`模型按名称推断为 ${fromSource.model}（哈希 ${fromSource.hash ?? '无'} 未登记）`)

  const pos = comment.v4_prompt?.caption ?? null
  const neg = comment.v4_negative_prompt?.caption ?? null
  const base = typeof pos?.base_caption === 'string' ? pos.base_caption : String(comment.prompt ?? fields.Description ?? '')
  const baseNegative = typeof neg?.base_caption === 'string' ? neg.base_caption : String(comment.uc ?? comment.negative_prompt ?? '')
  const posChars = Array.isArray(pos?.char_captions) ? pos.char_captions : []
  const negChars = Array.isArray(neg?.char_captions) ? neg.char_captions : []
  const useCoords = comment.v4_prompt?.use_coords === true
  const characters = posChars.map((row, index) => {
    const center = pointOf(Array.isArray(row?.centers) ? row.centers[0] : null)
    return {
      name: `Char${index + 1}`,
      positive: String(row?.char_caption ?? ''),
      negative: String(negChars[index]?.char_caption ?? ''),
      // Without coordinates the API arranges freely; the stored centre is a
      // placeholder then and is not shown as a position.
      center: useCoords ? center : null,
      rawCenter: center
    }
  })

  const width = finite(comment.width) ?? ihdr?.width ?? null
  const height = finite(comment.height) ?? ihdr?.height ?? null
  const params = {
    model: fromSource.model,
    width,
    height,
    seed: finite(comment.seed),
    steps: finite(comment.steps),
    scale: finite(comment.scale),
    sampler: typeof comment.sampler === 'string' ? comment.sampler : null,
    cfgRescale: finite(comment.cfg_rescale) ?? 0,
    noiseSchedule: typeof comment.noise_schedule === 'string' ? comment.noise_schedule : null,
    skipCfgAboveSigma: finite(comment.skip_cfg_above_sigma),
    dynamicThresholding: comment.dynamic_thresholding === true,
    sm: comment.sm === true,
    smDyn: comment.sm_dyn === true,
    preferBrownian: typeof comment.prefer_brownian === 'boolean' ? comment.prefer_brownian : null,
    deliberateEulerAncestralBug: typeof comment.deliberate_euler_ancestral_bug === 'boolean' ? comment.deliberate_euler_ancestral_bug : null,
    straightAlpha: typeof comment.straight_alpha === 'boolean' ? comment.straight_alpha : null,
    transparentBackground: comment.tag_hint_transparent_background === true,
    tagHintUcPreset: finite(comment.tag_hint_uc_preset),
    tagHintQt: finite(comment.tag_hint_qt),
    useCoords,
    useOrder: comment.v4_prompt?.use_order !== false,
    negUseCoords: comment.v4_negative_prompt?.use_coords === true,
    negUseOrder: comment.v4_negative_prompt?.use_order === true,
    legacyUc: comment.v4_negative_prompt?.legacy_uc === true,
    // img2img / inpaint records name the strength; the base image itself is not stored.
    strength: finite(comment.strength),
    noise: finite(comment.noise),
    requestType: typeof comment.request_type === 'string' ? comment.request_type : null,
    hasReference:
      (Array.isArray(comment.reference_strength_multiple) && comment.reference_strength_multiple.length > 0) ||
      (Array.isArray(comment.director_reference_strengths) && comment.director_reference_strengths.length > 0)
  }
  if (params.hasReference) notes.push('原图用了氛围参考 / 角色参考图，参考图本身不在 PNG 里，复现结果会有差异')
  if (params.requestType !== null && params.requestType !== 'PromptGenerateRequest') {
    notes.push(`原图是 ${params.requestType}（图生图 / 局部重绘之类），底图不在 PNG 里，只能按文生图复现`)
  }

  return {
    ok: true,
    origin,
    software: fields.Software ?? null,
    source: source || null,
    model: fromSource.model,
    modelExact: fromSource.exact,
    caption: { base, baseNegative, characters: characters.map(({ rawCenter: _raw, ...row }) => row) },
    params,
    replay: {
      prompt: base,
      negativePrompt: baseNegative,
      characters: characters.map((row) => ({ positive: row.positive, negative: row.negative, center: row.rawCenter })),
      ...params
    },
    notes
  }
}
