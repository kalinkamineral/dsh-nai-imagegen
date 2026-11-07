/**
 * Discover the accepted shape for NovelAI's character-position feature.
 *
 * `buildPayload` currently sends an empty `char_captions` and `use_coords: false`,
 * so the `|centers:C3` markers parsed out of a 「文生图」 block have nowhere to go.
 * Before writing the mapping into the plugin, this finds the wire shape the API
 * actually accepts — guessing here would either error or, worse, be silently
 * ignored and look like it worked.
 *
 * Probes at 64x64 / 1 step, which is far inside the free band, so finding the
 * shape costs nothing.
 *
 * Usage: node tests/centers-probe.mjs
 */
import { readFile } from 'node:fs/promises'
import { httpRequest } from '../lib/net.js'
import { proxyFor, systemProxy } from '../lib/nai.js'

const CONFIG = 'C:\\Users\\14552\\.dsh\\nai-imagegen\\config.json'
const config = JSON.parse(await readFile(CONFIG, 'utf8'))
const token = config.token || (config.keys ?? [])[0]?.token
if (!token) {
  console.log('no token available')
  process.exit(2)
}
const proxy = proxyFor(config)
console.log('proxy: ' + (proxy ?? '(direct)') + '\n')

const URL = 'https://image.novelai.net/ai/generate-image'
const SCENE = 'SFW,{{2girls}},side-by-side,standing,looking at viewer,transparent background'
const CHAR1 = 'girl,on left,blonde hair,single ponytail,blue eyes,halo,white bodysuit,feathered wings,standing'
const CHAR2 = 'girl,on right,brown hair,ahoge,blue eyes,headset,blue bodysuit,pink trim,winking,peace sign'
const NEG = 'nude,completely nude,nipples,lowres,bad anatomy'

/**
 * Grid cell to normalised centre. NovelAI's own grid is A–E across and 1–5 down,
 * with A leftmost and 1 topmost, so A1 is (0.1, 0.1) and C3 is the middle.
 * @param cell - a cell such as `B3`.
 * @returns the normalised point, or null when the cell is malformed.
 */
const toPoint = (cell) => {
  const m = /^([A-Ea-e])([1-5])$/.exec(String(cell ?? '').trim())
  if (m === null) return null
  const x = (m[1].toUpperCase().charCodeAt(0) - 65) * 0.2 + 0.1
  const y = (Number(m[2]) - 1) * 0.2 + 0.1
  return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) }
}

console.log('grid mapping: ' + ['A1', 'C3', 'B3', 'D3', 'E5'].map((c) => `${c}→${JSON.stringify(toPoint(c))}`).join('  ') + '\n')

/**
 * Build a full V5 payload with a given character-caption shape.
 * @param shape - how to express the captions.
 * @returns the request body.
 */
const payload = (shape) => {
  const parameters = {
    width: 64,
    height: 64,
    scale: 5,
    sampler: 'k_euler_ancestral',
    steps: 1,
    n_samples: 1,
    ucPreset: 3,
    qualityToggle: false,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: false,
    cfg_rescale: 0,
    noise_schedule: 'karras',
    legacy_v3_extend: false,
    uncond_scale: 1,
    negative_prompt: NEG,
    params_version: 4,
    prompt: SCENE,
    reference_image_multiple: [],
    reference_information_extracted_multiple: [],
    reference_strength_multiple: []
  }
  const chars = [
    { text: CHAR1, centers: [{ x: toPoint('B3').x, y: toPoint('B3').y }] },
    { text: CHAR2, centers: [{ x: toPoint('D3').x, y: toPoint('D3').y }] }
  ]
  if (shape === 'baseline') {
    parameters.v4_prompt = { use_coords: false, use_order: false, caption: { base_caption: `${SCENE},${CHAR1},${CHAR2}`, char_captions: [] } }
    parameters.v4_negative_prompt = { use_coords: false, use_order: false, caption: { base_caption: NEG, char_captions: [] } }
  } else if (shape === 'coords-points') {
    parameters.v4_prompt = {
      use_coords: true,
      use_order: true,
      caption: { base_caption: SCENE, char_captions: chars.map((c) => ({ char_caption: c.text, centers: c.centers })) }
    }
    parameters.v4_negative_prompt = { use_coords: true, use_order: true, caption: { base_caption: NEG, char_captions: [] } }
  } else if (shape === 'coords-strings') {
    parameters.v4_prompt = {
      use_coords: true,
      use_order: true,
      caption: { base_caption: SCENE, char_captions: [{ char_caption: CHAR1, centers: ['B3'] }, { char_caption: CHAR2, centers: ['D3'] }] }
    }
    parameters.v4_negative_prompt = { use_coords: true, use_order: true, caption: { base_caption: NEG, char_captions: [] } }
  } else if (shape === 'coords-noflags') {
    parameters.v4_prompt = {
      use_coords: false,
      use_order: false,
      caption: { base_caption: SCENE, char_captions: chars.map((c) => ({ char_caption: c.text, centers: c.centers })) }
    }
    parameters.v4_negative_prompt = { use_coords: false, use_order: false, caption: { base_caption: NEG, char_captions: [] } }
  }
  return { input: SCENE, model: 'nai-diffusion-5-full', action: 'generate', parameters }
}

for (const shape of ['baseline', 'coords-points', 'coords-strings', 'coords-noflags']) {
  const started = Date.now()
  try {
    const response = await httpRequest({
      url: URL,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify(payload(shape)),
      proxy,
      timeoutMs: 60000
    })
    const ms = Date.now() - started
    const ok = response.status >= 200 && response.status < 300
    const detail = ok ? `接受，返回 ${response.body.length} 字节` : response.body.toString('utf8').slice(0, 200)
    console.log(`  ${ok ? '✅' : '❌'} ${shape.padEnd(16)} HTTP ${response.status}  ${ms}ms  ${detail}`)
  } catch (error) {
    console.log(`  ❌ ${shape.padEnd(16)} 异常 ${String(error.message).slice(0, 120)}`)
  }
}
console.log('\n(random2) 系统代理探测：' + (systemProxy() ?? '无'))
