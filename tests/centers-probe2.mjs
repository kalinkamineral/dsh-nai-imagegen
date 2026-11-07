/**
 * Find which character-caption shape NovelAI actually accepts.
 *
 * The first probe only ever sent `char_captions` on the *positive* side, with the
 * negative's list empty. Wiring per-character negatives in — which is the point of
 * the split, since `Char1 UC` must not suppress the other character's features —
 * started returning 500 with a bare "Internal Server Error".
 *
 * This builds each candidate from the real `buildPayload`, so what is being tested
 * is what the plugin sends, and reports the status and the error body verbatim.
 * 64x64 at 1 step: inside the free band, so finding the shape costs nothing.
 *
 * Usage: node tests/centers-probe2.mjs
 */
import { readFile } from 'node:fs/promises'
import { httpRequest } from '../lib/net.js'
import { buildPayload, proxyFor } from '../lib/nai.js'

const config = JSON.parse(await readFile('C:\\Users\\14552\\.dsh\\nai-imagegen\\config.json', 'utf8'))
const token = config.token || (config.keys ?? [])[0]?.token
if (!token) {
  console.log('no token')
  process.exit(2)
}
const proxy = proxyFor(config)
const URL = 'https://image.novelai.net/ai/generate-image'

const base = {
  prompt: 'SFW,{{2girls}},side-by-side,blonde angel,brown-haired pilot',
  negativePrompt: 'brown hair,ahoge,headset,halo,wings,nude',
  model: 'nai-diffusion-5-full',
  width: 64,
  height: 64,
  steps: 1,
  scale: 5,
  sampler: 'k_euler_ancestral',
  sceneCaption: 'SFW,{{2girls}},side-by-side',
  sceneNegative: 'nude',
  characters: [
    { positive: 'girl,on left,blonde hair,halo', negative: 'brown hair,headset', centers: ['B3'] },
    { positive: 'girl,on right,brown hair,headset', negative: 'blonde hair,halo', centers: ['D3'] }
  ]
}

/**
 * Send one candidate and report what came back.
 * @param label - what the candidate changes.
 * @param mutate - receives the payload and returns the one to send.
 */
const attempt = async (label, mutate) => {
  const payload = buildPayload(base)
  const final = mutate(payload) ?? payload
  try {
    const response = await httpRequest({
      url: URL,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify(final),
      proxy,
      timeoutMs: 60000
    })
    const ok = response.status >= 200 && response.status < 300
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(46)} HTTP ${response.status}  ${ok ? `${response.body.length} 字节` : response.body.toString('utf8').slice(0, 150)}`)
    return ok
  } catch (error) {
    console.log(`  ❌ ${label.padEnd(46)} 异常 ${String(error.message).slice(0, 110)}`)
    return false
  }
}

console.log('proxy: ' + (proxy ?? '(direct)') + '\n')
console.log('=== 找到正/负向 char_captions 都能接受的形状 ===')

await attempt('as buildPayload produces it now', () => null)
await attempt('negative char_captions emptied', (p) => {
  p.parameters.v4_negative_prompt.caption.char_captions = []
  return p
})
await attempt('negative keeps captions but drops centers', (p) => {
  for (const row of p.parameters.v4_negative_prompt.caption.char_captions) row.centers = []
  return p
})
await attempt('negative keeps captions but use_coords/use_order off', (p) => {
  p.parameters.v4_negative_prompt.use_coords = false
  p.parameters.v4_negative_prompt.use_order = false
  return p
})
await attempt('negative captions carry the positive text', (p) => {
  p.parameters.v4_negative_prompt.caption.char_captions = p.parameters.v4_prompt.caption.char_captions.map((row) => ({ ...row }))
  return p
})
await attempt('positive captions only, negative empty + no coords', (p) => {
  p.parameters.v4_negative_prompt.caption.char_captions = []
  p.parameters.v4_negative_prompt.use_coords = false
  p.parameters.v4_negative_prompt.use_order = false
  return p
})
await attempt('no empty-char_caption rows at all', (p) => {
  p.parameters.v4_negative_prompt.caption.char_captions = p.parameters.v4_negative_prompt.caption.char_captions.filter((row) => row.char_caption !== '')
  return p
})
