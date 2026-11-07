/**
 * dsh-nai-imagegen — live inpaint probe.
 *
 * Constraint from the operator: no V5 and nothing outside the Opus free band.
 * This uses `nai-diffusion-4-5-full-inpainting`, 832×1216 (1,011,712 px ≤
 * 1,048,576), 28 steps and one image, so the expected charge is 0 Anlas and the
 * V5 usage battery is untouched.
 *
 * Builds both images locally (no dependency): a grey base and a mask whose
 * painted rectangle is the only opaque region, per the documented convention
 * "non-transparent pixels are regenerated".
 *
 * Run: node tests/live-inpaint-probe.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { generate, probe, proxyFor } from '../lib/nai.js'
import { load } from '../lib/config.js'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** @param {Buffer} bytes @returns {number} */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** @param {string} type @param {Buffer} data @returns {Buffer} */
function pngChunk(type, data) {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([header, body, crc])
}

/**
 * Encode an RGBA PNG (colour type 6) without any image library.
 * @param {number} width @param {number} height
 * @param {(x:number,y:number)=>[number,number,number,number]} pixel
 * @returns {Buffer}
 */
function makeRgbaPng(width, height, pixel) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = a
      offset += 4
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const config = await load()
const token =
  (process.env.NAI_TOKEN ?? '').trim() ||
  String(config.token ?? '').trim() ||
  String((config.keys ?? []).find((key) => key.enabled !== false)?.token ?? '').trim()
if (token === '') {
  console.error('no credential configured')
  process.exit(2)
}
const proxy = proxyFor(config)
const baseUrl = config.baseUrl

/** @returns {Promise<number>} */
async function anlas() {
  const result = await probe({ baseUrl, token, proxy })
  const subscription = result.subscription
  return Number(subscription?.fixedTrainingStepsLeft ?? 0) + Number(subscription?.purchasedTrainingStepsLeft ?? 0)
}

const work = await mkdtemp(join(tmpdir(), 'nai-inpaint-probe-'))
try {
  const width = 832
  const height = 1216
  const basePng = makeRgbaPng(width, height, () => [128, 128, 128, 255])
  // Opaque rectangle = the only region the model may repaint.
  const maskPng = makeRgbaPng(width, height, (x, y) =>
    x >= 200 && x < 600 && y >= 300 && y < 900 ? [255, 255, 255, 255] : [0, 0, 0, 0]
  )
  await writeFile(join(work, 'base.png'), basePng)
  await writeFile(join(work, 'mask.png'), maskPng)

  const before = await anlas()
  const startedAt = Date.now()
  const images = await generate({
    baseUrl,
    token,
    proxy,
    prompt: '1girl, solo, looking at viewer',
    negativePrompt: 'lowres, bad anatomy',
    model: 'nai-diffusion-4-5-full-inpainting',
    width,
    height,
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    seed: 777,
    nSamples: 1,
    ucPreset: 3,
    action: 'infill',
    image: basePng.toString('base64'),
    mask: maskPng.toString('base64'),
    addOriginalImage: true,
    inpaintStrength: 1
  })
  const after = await anlas()
  const output = images[0] ?? Buffer.alloc(0)
  const isPng = output.length > 24 && output[0] === 0x89 && output[1] === 0x50
  console.log(
    JSON.stringify(
      {
        model: 'nai-diffusion-4-5-full-inpainting',
        request: { width, height, steps: 28, samples: 1, inpaintStrength: 1 },
        anlas: { before, after, delta: before - after },
        output: { bytes: output.length, png: isPng, width: isPng ? output.readUInt32BE(16) : null, height: isPng ? output.readUInt32BE(20) : null },
        elapsedMs: Date.now() - startedAt
      },
      null,
      2
    )
  )
} catch (error) {
  console.error('probe failed:', error?.message ?? error)
  process.exitCode = 1
} finally {
  await rm(work, { recursive: true, force: true })
}
