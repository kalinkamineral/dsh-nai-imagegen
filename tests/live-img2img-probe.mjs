/**
 * dsh-nai-imagegen — live img2img probe (SPENDS QUOTA unless the request is free).
 *
 * Answers three questions with one measured render instead of an argument:
 *
 *   1. does /ai/generate-image accept action:'img2img' with the V4/V5 structured
 *      captions this client already sends,
 *   2. does a base image far larger than the output canvas survive (1536×1984
 *      source — 3,047,424 px, exactly NovelAI's cap — → 832×1216 output), and
 *   3. does the free band follow the output canvas rather than the source pixels
 *      — i.e. is the run 0 Anlas on an Opus account.
 *
 * Measured 2026-10-30: an 832×1216 source renders for 0 Anlas, a 1536×1984
 * source also renders for 0 Anlas, and a 1792×1792 source fails with a bare 500
 * because it exceeds NovelAI's 3,047,424 px resolution cap.
 *
 * Prints the Anlas delta from the subscription record; never prints the token.
 * Run: node tests/live-img2img-probe.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { generate, probe, proxyFor, readBaseImage } from '../lib/nai.js'
import { load } from '../lib/config.js'

// ------------------------------------------------------------------ PNG maker --
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
 * A valid 1536×1984 grey PNG: 3,047,424 px, exactly NovelAI's resolution cap and
 * nearly three times the Opus free-band area, on purpose.
 * @param {number} width @param {number} height @returns {Buffer}
 */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0x80)
  row[0] = 0
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** @returns {Promise<{fixedTrainingStepsLeft: number|null, purchasedTrainingStepsLeft: number|null}|null>} */
async function balance({ baseUrl, token, proxy }) {
  const result = await probe({ baseUrl, token, proxy })
  if (!result.ok && result.subscription === null) throw new Error(`balance read failed: ${result.detail}`)
  return result.subscription
}

/** @param {object|null} subscription @returns {number} */
function remaining(subscription) {
  if (subscription === null) return Number.NaN
  return Number(subscription.fixedTrainingStepsLeft ?? 0) + Number(subscription.purchasedTrainingStepsLeft ?? 0)
}

const config = await load()
const token = (process.env.NAI_TOKEN ?? '').trim() || String(config.token ?? '').trim() || String((config.keys ?? []).find((key) => key.enabled !== false)?.token ?? '').trim()
if (token === '') {
  console.error('no NovelAI credential configured; skipping the live probe')
  process.exitCode = 2
} else {
  const proxy = proxyFor(config)
  const work = await mkdtemp(join(tmpdir(), 'nai-i2i-probe-'))
  try {
    const sourceFile = join(work, 'probe-1536x1984.png')
    await writeFile(sourceFile, makePng(1536, 1984))
    const image = await readBaseImage({ root: work, filePath: 'probe-1536x1984.png' })

    const before = await balance({ baseUrl: config.baseUrl, token, proxy })
    const startedAt = Date.now()
    const images = await generate({
      baseUrl: config.baseUrl,
      token,
      proxy,
      prompt: '1girl, solo, looking at viewer',
      negativePrompt: 'lowres, bad anatomy',
      model: 'nai-diffusion-4-5-full',
      width: 832,
      height: 1216,
      steps: 28,
      scale: 5,
      sampler: 'k_euler_ancestral',
      seed: 12345,
      nSamples: 1,
      ucPreset: 3,
      action: 'img2img',
      image: image.base64,
      strength: 0.5,
      noise: 0
    })
    const after = await balance({ baseUrl: config.baseUrl, token, proxy })
    const elapsedMs = Date.now() - startedAt
    const output = images[0]
    const isPng = output !== undefined && output[0] === 0x89 && output[1] === 0x50
    const outputWidth = isPng ? output.readUInt32BE(16) : null
    const outputHeight = isPng ? output.readUInt32BE(20) : null

    console.log(
      JSON.stringify(
        {
          source: { width: image.width, height: image.height, bytes: image.bytes, mime: image.mime },
          request: { width: 832, height: 1216, steps: 28, strength: 0.5, model: 'nai-diffusion-4-5-full', samples: 1 },
          anlas: { before: remaining(before), after: remaining(after), delta: remaining(before) - remaining(after) },
          output: { bytes: output?.length ?? 0, png: isPng, width: outputWidth, height: outputHeight },
          elapsedMs
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
}
