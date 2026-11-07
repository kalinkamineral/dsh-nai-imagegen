/**
 * dsh-nai-imagegen — the NovelAI image models this plugin knows.
 *
 * One table, so the panel's model picker, the inpainting mapping and every
 * per-family switch (UC preset table, noise schedule, variety, 透明底, SMEA,
 * structured captions) agree on what a model id is. The ids follow nai-dbgen's
 * `param-options.js`; the curated models behave exactly like their family's
 * full model, they were only trained on a narrower (SFW) set.
 */

/**
 * The selectable models, newest first. `inpaint` marks the inpainting variants,
 * which only the 局部重绘 path may use.
 */
export const MODEL_OPTIONS = Object.freeze([
  { id: 'nai-diffusion-5-full', label: 'NAI Diffusion V5 Full', family: 'v5', inpaint: false },
  { id: 'nai-diffusion-5-curated', label: 'NAI Diffusion V5 Curated', family: 'v5', inpaint: false },
  { id: 'nai-diffusion-5-full-inpainting', label: 'NAI Diffusion V5 Full Inpainting', family: 'v5', inpaint: true },
  { id: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 Full', family: 'v4.5', inpaint: false },
  { id: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion V4.5 Curated', family: 'v4.5', inpaint: false },
  { id: 'nai-diffusion-4-5-full-inpainting', label: 'NAI Diffusion V4.5 Full Inpainting', family: 'v4.5', inpaint: true },
  { id: 'nai-diffusion-4-5-curated-inpainting', label: 'NAI Diffusion V4.5 Curated Inpainting', family: 'v4.5', inpaint: true },
  { id: 'nai-diffusion-4-full', label: 'NAI Diffusion V4 Full', family: 'v4', inpaint: false },
  { id: 'nai-diffusion-4-curated-preview', label: 'NAI Diffusion V4 Curated', family: 'v4', inpaint: false },
  { id: 'nai-diffusion-4-full-inpainting', label: 'NAI Diffusion V4 Full Inpainting', family: 'v4', inpaint: true },
  { id: 'nai-diffusion-4-curated-inpainting', label: 'NAI Diffusion V4 Curated Inpainting', family: 'v4', inpaint: true },
  { id: 'nai-diffusion-3', label: 'NAI Diffusion Anime V3', family: 'v3', inpaint: false },
  { id: 'nai-diffusion-3-inpainting', label: 'NAI Diffusion Anime V3 Inpainting', family: 'v3', inpaint: true },
  { id: 'nai-diffusion-furry-3', label: 'NAI Diffusion Furry V3', family: 'v3', inpaint: false },
  { id: 'nai-diffusion-furry-3-inpainting', label: 'NAI Diffusion Furry V3 Inpainting', family: 'v3', inpaint: true }
])

/**
 * The family of a model id: `v5`, `v4.5`, `v4`, `v3`, or `null` when unknown.
 *
 * Decided by prefix, in this order, so an id the table does not list yet (a new
 * curated or inpainting variant) still lands in its family. `4-5` must be tested
 * before `4`, which it also starts with.
 *
 * @param model - a model id.
 * @returns the family.
 */
export function modelFamily(model) {
  const id = String(model ?? '').trim().toLowerCase()
  if (id.startsWith('nai-diffusion-5')) return 'v5'
  if (id.startsWith('nai-diffusion-4-5')) return 'v4.5'
  if (id.startsWith('nai-diffusion-4')) return 'v4'
  if (id.startsWith('nai-diffusion-3') || id.startsWith('nai-diffusion-furry-3')) return 'v3'
  return null
}

/**
 * Whether a model takes the V4+ structured caption (`v4_prompt` and friends).
 * @param model - a model id.
 * @returns true for V4, V4.5 and V5.
 */
export function usesStructuredCaption(model) {
  const family = modelFamily(model)
  return family === 'v5' || family === 'v4.5' || family === 'v4'
}

/**
 * Explicit inpainting siblings where appending `-inpainting` would name a model
 * that does not exist.
 */
const INPAINT_MAP = Object.freeze({
  // There is no V5 Curated inpainting model; V5 Full's is the nearest.
  'nai-diffusion-5-curated': {
    model: 'nai-diffusion-5-full-inpainting',
    note: 'V5 Curated 没有局部重绘模型，已改用 V5 Full Inpainting（nai-diffusion-5-full-inpainting）。'
  },
  'nai-diffusion-4-curated-preview': { model: 'nai-diffusion-4-curated-inpainting', note: '' }
})

/**
 * The inpainting model for a requested model.
 * @param model - the configured or requested model id.
 * @returns `{ model, note }`; `note` is `''` unless the mapping is worth telling.
 */
export function inpaintingModelFor(model) {
  const id = String(model ?? '').trim()
  if (id === '') return { model: id, note: '' }
  if (/-inpainting$/i.test(id)) return { model: id, note: '' }
  const mapped = INPAINT_MAP[id.toLowerCase()]
  if (mapped !== undefined) return { ...mapped }
  return { model: `${id}-inpainting`, note: '' }
}
