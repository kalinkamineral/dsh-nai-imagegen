/**
 * dsh-nai-imagegen — offline verification.
 *
 * Everything here is pure: no network, no credential, no render. It exists
 * because `package.json` has always advertised `npm run verify` while pointing
 * at a file that did not exist, so nothing caught a broken request body until a
 * live render did.
 *
 * Run with `npm run verify` (or `node tests/verify.mjs`). Exit code 1 on the
 * first failing group; every passing check prints `ok`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { acceptForDecode, buildPayload, decodeResponse, generateUrlCandidates, insideFreeBand, readBaseImage, sniffImage, MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS } from '../lib/nai.js'
import { httpRequest } from '../lib/net.js'
import { createServer } from 'node:http'
import { defaults as configDefaults, sourceDirOf } from '../lib/config.js'
import { characterEditPrompt, mergeEditDraft, normalizeEditDraft, validateEditReply } from '../lib/character-edit.js'
import { estimateView, formatBytes, generateView, listItems, nativePanelView, panelView, probeView, studioView, stripText, toolCard } from '../lib/dsh-go.js'
import { apply, applyWriterResult, sourceListing, writerErrorMessage } from '../index.js'
import { augmentWriterSystem, parseWriterReply, toolCallArguments, toolCallToFlat } from '../lib/writer.js'
import { isWithin, resolveWithin } from '../lib/util.js'

let passed = 0
const failures = []

/**
 * Run one named check.
 * @param name - what the check proves.
 * @param fn - the check body; throw to fail.
 */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}\n  ${error?.message ?? error}`)
  }
}

// ---------------------------------------------------------------- PNG fixture --
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
 * Build a valid solid-black RGB PNG without any image library.
 * @param {number} width @param {number} height @returns {Buffer}
 */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const row = Buffer.alloc(1 + width * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ------------------------------------------------------------------- payload --
const base = {
  prompt: '1girl, solo',
  negativePrompt: 'lowres',
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  sampler: 'k_euler_ancestral',
  seed: 42,
  nSamples: 1,
  ucPreset: 3
}

await check('text-to-image payload keeps action=generate and carries no base image', () => {
  const body = buildPayload(base)
  assert.equal(body.action, 'generate')
  assert.equal(body.parameters.image, undefined)
  assert.equal(body.parameters.strength, undefined)
  assert.equal(body.parameters.noise, undefined)
  assert.equal(body.parameters.width, 832)
  assert.equal(body.parameters.v4_prompt.caption.base_caption, '1girl, solo')
})

await check('img2img payload posts bare base64, strength and noise', () => {
  const body = buildPayload({ ...base, action: 'img2img', image: 'QUJD', strength: 0.42, noise: 0.05 })
  assert.equal(body.action, 'img2img')
  assert.equal(body.parameters.image, 'QUJD')
  assert.equal(body.parameters.strength, 0.42)
  assert.equal(body.parameters.noise, 0.05)
  // V4/V5 still need both structured captions; i2i must not drop them.
  assert.ok(body.parameters.v4_prompt)
  assert.ok(body.parameters.v4_negative_prompt)
})

await check('img2img refuses to build a payload without a base image', () => {
  assert.throws(() => buildPayload({ ...base, action: 'img2img' }), /img2img requires a base image/)
})

await check('img2img strength and noise are clamped to the API range', () => {
  const high = buildPayload({ ...base, action: 'img2img', image: 'QUJD', strength: 9, noise: 9 })
  assert.equal(high.parameters.strength, 0.99)
  assert.equal(high.parameters.noise, 0.99)
  const low = buildPayload({ ...base, action: 'img2img', image: 'QUJD', strength: -3, noise: -3 })
  assert.equal(low.parameters.strength, 0.01)
  assert.equal(low.parameters.noise, 0)
  const defaults = buildPayload({ ...base, action: 'img2img', image: 'QUJD' })
  assert.equal(defaults.parameters.strength, 0.5)
  assert.equal(defaults.parameters.noise, 0)
})

// --------------------------------------------------------------- free band --
await check('insideFreeBand follows pixel area, steps and sample count only', () => {
  assert.equal(insideFreeBand({ width: 832, height: 1216, steps: 28 }), true)
  assert.equal(insideFreeBand({ width: 1024, height: 1024, steps: 28 }), true)
  assert.equal(insideFreeBand({ width: 1024, height: 1536, steps: 28 }), false)
  assert.equal(insideFreeBand({ width: 832, height: 1216, steps: 29 }), false)
  assert.equal(insideFreeBand({ width: 832, height: 1216, steps: 28, nSamples: 2 }), false)
})

// -------------------------------------------------------------- image sniff --
await check('sniffImage reads PNG dimensions from IHDR', () => {
  const sniffed = sniffImage(makePng(1024, 1536))
  assert.equal(sniffed.mime, 'image/png')
  assert.equal(sniffed.width, 1024)
  assert.equal(sniffed.height, 1536)
})

await check('sniffImage reads JPEG dimensions from SOF0', () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(14, 0),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20]),
    Buffer.alloc(9, 0)
  ])
  const sniffed = sniffImage(jpeg)
  assert.equal(sniffed.mime, 'image/jpeg')
  assert.equal(sniffed.width, 800)
  assert.equal(sniffed.height, 600)
})

await check('sniffImage rejects a non-image buffer', () => {
  assert.equal(sniffImage(Buffer.from('not an image at all')), null)
})

// -------------------------------------------------------------- readBaseImage --
const root = await mkdtemp(join(tmpdir(), 'nai-i2i-'))
try {
  const inside = join(root, 'base.png')
  await writeFile(inside, makePng(64, 96))

  await check('readBaseImage accepts a PNG inside the source directory', async () => {
    const image = await readBaseImage({ root, filePath: 'base.png' })
    assert.equal(image.mime, 'image/png')
    assert.equal(image.width, 64)
    assert.equal(image.height, 96)
    assert.equal(image.name, 'base.png')
    assert.equal(Buffer.from(image.base64, 'base64').length, image.bytes)
  })

  await check('readBaseImage refuses a path outside the source directory', async () => {
    // Cross-platform escape forms: `..` is a real parent segment on both
    await assert.rejects(() => readBaseImage({ root, filePath: join('..', 'outside.png') }), /outside the allowed directory/)
    await assert.rejects(() => readBaseImage({ root, filePath: join(tmpdir(), 'outside.png') }), /outside the allowed directory/)
  })

  await check('readBaseImage refuses a missing file and a non-image file', async () => {
    await assert.rejects(() => readBaseImage({ root, filePath: 'missing.png' }), /底图不存在/)
    await writeFile(join(root, 'notes.txt'), 'hello')
    await assert.rejects(() => readBaseImage({ root, filePath: 'notes.txt' }), /不是 PNG\/JPEG\/WebP/)
  })

  await check('readBaseImage enforces the byte ceiling', async () => {
    const big = join(root, 'big.png')
    await writeFile(big, makePng(512, 512))
    await assert.rejects(() => readBaseImage({ root, filePath: 'big.png', maxBytes: 128 }), /超过上限/)
  })

  await check('readBaseImage refuses a base image above NovelAI pixel cap', async () => {
    // 1792x1792 = 3,211,264 px: measured to fail upstream with a bare 500.
    await writeFile(join(root, 'huge.png'), makePng(1792, 1792))
    await assert.rejects(() => readBaseImage({ root, filePath: 'huge.png' }), /超过 NovelAI 的 3,047,424 px 上限/)
  })

  await check('readBaseImage refuses an empty file', async () => {
    await writeFile(join(root, 'empty.png'), '')
    await assert.rejects(() => readBaseImage({ root, filePath: 'empty.png' }), /空文件/)
  })

  await check('the default byte ceiling is a positive sane number', () => {
    assert.ok(Number.isFinite(MAX_SOURCE_BYTES) && MAX_SOURCE_BYTES >= 1024 * 1024)
    // The measured upstream cap; a wrong constant here would turn a 500 into a
    // local false rejection or vice versa.
    assert.equal(MAX_SOURCE_PIXELS, 3_047_424)
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

// ------------------------------------------------------------- path helpers --
await check('sourceDirOf derives the source folder from the output directory when unset', async () => {
  const outputDir = join(tmpdir(), 'proj', '_out', 'nai')
  assert.equal(await sourceDirOf({ sourceDir: '', outputDir }), join(tmpdir(), 'proj', '_in', 'nai'))
  const customBase = join(tmpdir(), 'custom', 'base')
  assert.equal(await sourceDirOf({ sourceDir: customBase, outputDir }), customBase)
})

await check('resolveWithin accepts inside paths and rejects escapes', () => {
  const dir = join(tmpdir(), 'nai-root')
  assert.equal(resolveWithin(dir, 'a.png'), join(dir, 'a.png'))
  assert.equal(isWithin(dir, join(dir, 'sub', 'a.png')), true)
  assert.equal(isWithin(dir, join(tmpdir(), 'other', 'a.png')), false)
  assert.throws(() => resolveWithin(dir, join('..', 'a.png')), /outside the allowed directory/)
  assert.throws(() => resolveWithin(dir, ''), /empty path/)
})

await check('sourceListing lists image files only and skips the rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nai-src-'))
  try {
    await writeFile(join(dir, 'a.png'), makePng(8, 8))
    await writeFile(join(dir, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    await writeFile(join(dir, 'c.webp'), Buffer.from('RIFF0000WEBP', 'ascii'))
    await writeFile(join(dir, 'notes.txt'), 'not an image')
    const rows = await sourceListing(dir, 10)
    assert.deepEqual(
      rows.map((row) => row.name).sort(),
      ['a.png', 'b.jpg', 'c.webp']
    )
    assert.ok(rows.every((row) => typeof row.bytes === 'number' && typeof row.mtime === 'number'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('the V5 wire payload carries the shared-trial flag', () => {
  const base = { prompt: '1girl, solo', width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral' }
  const v5 = buildPayload({ ...base, model: 'nai-diffusion-5-full' })
  assert.equal(v5.use_new_shared_trial, true)
  assert.equal(v5.parameters.width, 832)
  const v3 = buildPayload({ ...base, model: 'nai-diffusion-3' })
  assert.equal(v3.use_new_shared_trial, undefined)
  const off = buildPayload({ ...base, model: 'nai-diffusion-5-full', useNewSharedTrial: false })
  assert.equal(off.use_new_shared_trial, undefined)
})

await check('config defaults carry the render deadline and shared-trial flag', () => {
  const defaults = configDefaults()
  assert.equal(defaults.requestTimeoutMs, 300000)
  assert.equal(defaults.useNewSharedTrial, true)
  assert.equal(defaults.writerAdult, false)
  assert.equal(defaults.writerToolCall, false)
})

await check('the writer extras append the adult and tool-call rules only when asked', () => {
  assert.equal(augmentWriterSystem('BASE', {}), 'BASE')
  const adult = augmentWriterSystem('BASE', { adult: true })
  assert.match(adult, /创作范围/)
  assert.ok(!adult.includes('输出通道'))
  const both = augmentWriterSystem('BASE', { adult: true, toolCall: true })
  assert.match(both, /输出通道/)
  assert.match(both, /submit_caption/)
})

await check('a tool-call reply flattens into the caption field grammar', () => {
  const reply = JSON.stringify({
    tool: 'submit_caption',
    arguments: {
      analysis: '测试',
      scene: '1girl, solo',
      scene_uc: 'lowres',
      char: [{ center: [0.5, 0.5], positive: 'red hair', negative: 'hat' }]
    }
  })
  const args = toolCallArguments(reply)
  assert.ok(args, 'arguments must be extracted')
  const flat = toolCallToFlat(args)
  assert.match(flat, /scene: 1girl, solo/)
  const parsed = parseWriterReply(flat)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.caption.base, '1girl, solo')
  assert.equal(parsed.caption.characters.length, 1)
  assert.equal(parsed.caption.characters[0].positive, 'red hair')
})

await check('httpRequest enforces its overall deadline on a trickling response', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    // One byte now, never an end: the idle timeout never fires, only the total one.
    res.write('x')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await assert.rejects(
      () => httpRequest({ url: `http://127.0.0.1:${port}/slow`, timeoutMs: 5000, totalTimeoutMs: 150 }),
      (error) => error?.code === 'ETOTAL_TIMEOUT' || /total deadline/.test(String(error?.message ?? error))
    )
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})

await check('generation URLs fall back to the raw relay mount point', () => {
  assert.deepEqual(generateUrlCandidates('https://relay.example'), ['https://relay.example/ai/generate-image'])
  assert.deepEqual(generateUrlCandidates('https://relay.example/ai'), ['https://relay.example/ai/generate-image'])
  assert.deepEqual(generateUrlCandidates('https://relay.example/ai/generate-image'), ['https://relay.example/ai/generate-image'])
  assert.deepEqual(generateUrlCandidates('https://relay.example/api/nai'), [
    'https://relay.example/api/nai/ai/generate-image',
    'https://relay.example/api/nai'
  ])
})

await check('sourceListing returns an empty list for a missing directory', async () => {
  assert.deepEqual(await sourceListing(join(tmpdir(), 'nai-src-does-not-exist'), 5), [])
})

await check('httpRequest reports download progress and the declared total', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '8' })
    res.write('abcd')
    setTimeout(() => res.end('efgh'), 30)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const events = []
  try {
    const response = await httpRequest({
      url: `http://127.0.0.1:${port}/chunked`,
      onProgress: (info) => events.push({ ...info })
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.toString(), 'abcdefgh')
    assert.ok(events.length >= 2, JSON.stringify(events))
    assert.equal(events[0].headers, true)
    assert.equal(events[0].received, 0)
    assert.equal(events[0].total, 8)
    assert.equal(events[events.length - 1].received, 8)
  } finally {
    server.close()
  }
})

// --------------------------------------------------------- decode setting --
await check('the decoder setting maps to the right Accept header', async () => {
  assert.equal(acceptForDecode('json'), 'application/json')
  assert.match(acceptForDecode('zip'), /application\/zip/)
  assert.equal(acceptForDecode('auto'), '*/*')
  assert.equal(acceptForDecode(undefined), '*/*')
  assert.equal(acceptForDecode('JSON'), 'application/json')
})

await check('a JSON base64 envelope decodes to the PNG bytes', async () => {
  const png = makePng(8, 8)
  const body = Buffer.from(JSON.stringify({ images: [{ image: png.toString('base64') }] }))
  const decoded = decodeResponse(body, 'application/json')
  assert.equal(decoded.length, 1)
  assert.deepEqual(decoded[0], png)
})

// ------------------------------------------------------- character rewrite --
await check('the character rewrite prompt carries the instruction and the current DNA', async () => {
  const prompt = characterEditPrompt(
    { name: '简·伊芙加登', keywords: ['简'], fixedFeatures: 'red hair, red eyes', variableFeatures: [{ name: '制服', prompt: 'school uniform' }], negative: 'blue hair' },
    '把发色改成银白色'
  )
  assert.match(prompt.user, /把发色改成银白色/)
  assert.match(prompt.user, /red hair, red eyes/)
  assert.match(prompt.user, /school uniform/)
  assert.match(prompt.system, /fixedFeatures/)
  assert.equal(typeof prompt.system, 'string')
})

await check('normalizeEditDraft falls back to the current character for missing fields', async () => {
  const base = { name: '甲', keywords: ['甲'], fixedFeatures: 'red hair', variableFeatures: [{ name: '校服', prompt: 'uniform' }], negative: 'blue hair' }
  const draft = normalizeEditDraft({ fixedFeatures: 'silver hair' }, base)
  assert.equal(draft.fixedFeatures, 'silver hair')
  assert.equal(draft.name, '甲')
  assert.deepEqual(draft.keywords, ['甲'])
  assert.deepEqual(draft.variableFeatures, [{ name: '校服', prompt: 'uniform' }])
  assert.equal(draft.negative, 'blue hair')
})

await check('an empty variableFeatures reply clears the outfit list on purpose', async () => {
  const draft = normalizeEditDraft({ fixedFeatures: 'x', variableFeatures: [] }, { variableFeatures: [{ name: 'a', prompt: 'b' }] })
  assert.deepEqual(draft.variableFeatures, [])
})

await check('mergeEditDraft keeps the host-owned ids while taking the new features', async () => {
  const merged = mergeEditDraft(
    { id: 'ch-1', groupId: 'grp-1', name: '甲', fixedFeatures: 'red hair', createdAt: '2026-01-01T00:00:00.000Z' },
    normalizeEditDraft({ fixedFeatures: 'silver hair', keywords: ['甲', 'jia'], analysis: 'ok' })
  )
  assert.equal(merged.id, 'ch-1')
  assert.equal(merged.groupId, 'grp-1')
  assert.equal(merged.fixedFeatures, 'silver hair')
  assert.deepEqual(merged.keywords, ['甲', 'jia'])
  assert.equal(merged.createdAt, '2026-01-01T00:00:00.000Z')
})

await check('validateEditReply rejects a reply without fixedFeatures', async () => {
  assert.ok(validateEditReply(null).length > 0)
  assert.ok(validateEditReply({ name: 'x' }).length > 0)
  assert.equal(validateEditReply({ fixedFeatures: '', variableFeatures: [] }).length, 0)
  assert.ok(validateEditReply({ fixedFeatures: 'x', variableFeatures: {} }).length > 0)
})

// ---------------------------------------------------------------- dsh-go ----
/** Component names every dsh-go App understands (v1 set). */
const DSH_GO_TYPES = new Set(['stack', 'row', 'text', 'callout', 'steps', 'compare', 'metric', 'chart', 'progress', 'list', 'keyValue', 'table', 'actions', 'image', 'options', 'confirm'])

/**
 * Count nodes and measure depth of a view tree, the way the App budgets it.
 * @param node - the view node.
 * @param depth - current depth, from 1.
 * @returns `{ nodes, depth }`.
 */
function viewStats(node, depth = 1) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return { nodes: 0, depth: 0 }
  let nodes = 1
  let maxDepth = depth
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const stats = viewStats(child, depth + 1)
    nodes += stats.nodes
    maxDepth = Math.max(maxDepth, stats.depth)
  }
  return { nodes, depth: maxDepth }
}

await check('the dsh-go manifest declares the strip and the panel', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const manifest = pkg.dshGo
  assert.equal(manifest.v, 1)
  assert.ok(manifest.contributes.panels.some((row) => row.id === 'novelai'))
  assert.ok(manifest.contributes['composer.strip'].some((row) => row.panel === 'novelai'))
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
  for (const row of [...manifest.contributes.panels, ...manifest.contributes['composer.strip']]) assert.match(row.id, idPattern)
  const ids = manifest.contributes.panels.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, 'panel ids must be unique')
  assert.ok(manifest.contributes.panels.length <= 4)
  // 输入框胶囊：一个「AI 写词」入口，读输入框草稿。
  const capsules = manifest.contributes['composer.actions']
  assert.ok(Array.isArray(capsules) && capsules.length <= 2)
  const writerCapsule = capsules.find((row) => row.id === 'nai-writer')
  assert.ok(writerCapsule, 'the AI writer capsule must be declared')
  assert.ok(writerCapsule.label.zh.length <= 10 && writerCapsule.label.en.length <= 10)
  assert.ok(manifest.wants.includes('draft'))
  const allIds = [
    ...manifest.contributes.panels.map((row) => row.id),
    ...manifest.contributes['composer.strip'].map((row) => row.id),
    ...capsules.map((row) => row.id)
  ]
  assert.equal(new Set(allIds).size, allIds.length, 'slot ids must be unique across slots')
  assert.ok(Buffer.byteLength(JSON.stringify(manifest), 'utf8') <= 16 * 1024)
})

await check('the dsh-go panel view stays inside the panel budget', async () => {
  for (const locale of ['zh', 'en']) {
    const view = panelView({ locale })
    const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
    const stats = viewStats(view)
    assert.ok(bytes <= 32 * 1024, `${locale}: ${bytes} bytes`)
    assert.ok(stats.nodes <= 120, `${locale}: ${stats.nodes} nodes`)
    assert.ok(stats.depth <= 8, `${locale}: depth ${stats.depth}`)
    const types = []
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (typeof node.type === 'string') types.push(node.type)
      for (const value of Object.values(node)) walk(value)
    }
    walk(view)
    for (const type of types) assert.ok(DSH_GO_TYPES.has(type), `unknown component ${type}`)
  }
})

const STUDIO_INPUT_TYPES = new Set(['textField', 'number', 'stepper', 'toggle', 'select', 'segmented', 'chips', 'slider', 'date', 'time', 'rating'])

/** Walk a v2 view and collect every node. */
function collectNodes(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out)
    return out
  }
  if (typeof node.type === 'string') out.push(node)
  for (const value of Object.values(node)) collectNodes(value, out)
  return out
}

const STUDIO_CAPS = {
  components: ['stack', 'text', 'callout', 'list', 'actions', 'form', 'textField', 'number', 'stepper', 'toggle', 'select', 'segmented']
}

await check('the studio view degrades to v1 on an app without inputs', async () => {
  const view = studioView({ locale: 'zh', components: ['stack', 'text', 'callout', 'list', 'actions'] })
  assert.equal(view.v, 1)
  const types = collectNodes(view).map((node) => node.type)
  assert.ok(!types.includes('form'))
  assert.ok(!types.includes('textField'))
  assert.ok(types.includes('callout'))
})

await check('the studio view is a valid native form inside the panel budget', async () => {
  for (const locale of ['zh', 'en']) {
    const view = studioView({ ...STUDIO_CAPS, locale })
    const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
    const stats = viewStats(view)
    assert.ok(bytes <= 32 * 1024, `${locale}: ${bytes} bytes`)
    assert.ok(stats.nodes <= 120, `${locale}: ${stats.nodes} nodes`)
    assert.ok(stats.depth <= 8, `${locale}: depth ${stats.depth}`)
    const nodes = collectNodes(view)
    const types = [...new Set(nodes.map((node) => node.type))]
    for (const type of types) assert.ok(type === 'form' || DSH_GO_TYPES.has(type) || STUDIO_INPUT_TYPES.has(type), `unknown component ${type}`)
    const form = nodes.find((node) => node.type === 'form')
    assert.ok(form, 'the workbench must be a real form')
    assert.equal(form.submit, 'generate')
    const inputs = nodes.filter((node) => STUDIO_INPUT_TYPES.has(node.type))
    assert.ok(inputs.length >= 8, `${locale}: ${inputs.length} inputs`)
    for (const input of inputs) {
      assert.equal(typeof input.label, 'string')
      assert.ok(input.label.length > 0)
      assert.match(input.bind, /^data\.(form|writer)\.[A-Za-z0-9]+$/)
      assert.equal(input.onChange, 'changed')
    }
    // The submit button lives on the form, so its label must exist in both languages.
    assert.ok(String(form.submitLabel ?? '').length > 0)
    // 「AI 写词」 rides on the same view: a bound draft plus its two actions.
    const writerField = nodes.find((node) => node.bind === 'data.writer.text')
    assert.ok(writerField, 'the writer textField must be bound to data.writer.text')
    assert.equal(writerField.type, 'textField')
    assert.equal(writerField.onChange, 'changed')
    const actionItems = nodes.filter((node) => node.type === 'actions').flatMap((node) => node.items ?? [])
    assert.ok(actionItems.some((item) => item.action === 'write'), 'the write action must be wired')
    assert.ok(actionItems.some((item) => item.action === 'cancelWrite'), 'the cancelWrite action must be wired')
  }
})

/** Mount the host with a fake dsh-go bridge and capture the panels. */
async function capturePanels() {
  const panels = new Map()
  const handlers = new Map()
  const ctx = {
    tools: { register: () => () => {} },
    effect: (fn) => {
      fn()
      return () => {}
    },
    webServer: { register: () => () => {} },
    inject: (_services, fn) =>
      fn({
        dshGo: {
          panel: (id, config) => panels.set(id, config),
          strip: () => () => {},
          on: (id, handler) => handlers.set(id, handler)
        }
      })
  }
  apply(ctx)
  // Attach the handlers to the returned Map so existing call sites keep working.
  panels.handlers = handlers
  return panels
}

/**
 * Mount the host and capture every registered tool.
 * @returns {Promise<Map<string, object>>} tool name → definition.
 */
async function captureTools() {
  const tools = new Map()
  const ctx = {
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool)
        return () => {}
      }
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
    webServer: { register: () => () => {} }
  }
  apply(ctx)
  return tools
}

await check('the studio panel is registered and emits its form defaults', async () => {
  const panels = await capturePanels()
  assert.ok(panels.has('novelai'), 'the studio panel must be registered')
  const studio = panels.get('novelai')
  assert.equal(typeof studio.view, 'function')
  assert.equal(typeof studio.data, 'function')
  for (const action of [
    'generate', 'changed', 'cancel', 'write', 'cancelWrite', 'copyFile',
    'pickArtist', 'pickSource', 'runEdit', 'cancelEdit',
    'refreshGallery', 'lookup', 'copyHit', 'saveSettings', 'runDoctor'
  ]) assert.equal(typeof studio.actions[action], 'function', action)

  const emitted = []
  const stop = studio.data({ sessionId: 'studio-test' }, (data) => emitted.push(data), { locale: 'zh' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  stop()
  assert.ok(emitted.length >= 1, 'the panel must emit a first snapshot')
  const first = emitted[0]
  assert.equal(first.form.size, '832x1216')
  assert.equal(first.form.useArtist, true)
  assert.match(first.jobText, /还没有任务/)
  assert.match(first.estimateText, /相对消耗/)
  assert.deepEqual(first.resultItems, [])
  assert.equal(first.writer.text, '')
  assert.equal(typeof first.writerText, 'string')
  assert.equal(first.writerError, '')
})

await check('the studio panel keeps typed values and refuses an empty prompt', async () => {
  const panels = await capturePanels()
  const studio = panels.get('novelai')
  const scope = { sessionId: 'studio-test-typing' }
  studio.actions.changed(scope, { value: { bind: 'data.form.prompt', value: '1girl, solo' } })

  const emitted = []
  const stop = studio.data(scope, (data) => emitted.push(data), { locale: 'zh' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  stop()
  assert.equal(emitted.at(-1).form.prompt, '1girl, solo')

  const refused = await studio.actions.generate({ sessionId: 'studio-test-empty' }, { value: { values: {} } })
  assert.match(String(refused.toast ?? ''), /提示词/)
  const cancelled = studio.actions.cancel({ sessionId: 'studio-test-empty' })
  assert.match(String(cancelled.toast ?? ''), /取消/)
})

await check('writer results split into scene and character fields', () => {
  // Local change: the workbench keeps 场景 / 角色 in separate fields, so the writer
  // puts `base` in the scene box and each character caption on its own line.
  const state = { form: { prompt: '', characters: '', negative: 'lowres', size: '832x1216' } }
  applyWriterResult(state, {
    caption: {
      base: '1girl, rooftop',
      baseNegative: 'blurry',
      characters: [{ positive: 'red hair', negative: 'hat' }]
    },
    size: { width: 1216, height: 832 }
  })
  assert.equal(state.form.prompt, '1girl, rooftop')
  assert.equal(state.form.characters, 'red hair')
  assert.equal(state.form.negative, 'lowres, blurry, hat')
  assert.equal(state.form.size, '1216x832')

  // A size the segmented control does not offer must not overwrite the form.
  applyWriterResult(state, { caption: { base: 'x', baseNegative: '', characters: [] }, size: { width: 900, height: 900 } })
  assert.equal(state.form.size, '1216x832')

  assert.equal(writerErrorMessage({ code: 'WRITER_REFUSED' }), '模型拒绝了这次写词')
  assert.match(writerErrorMessage({ status: 503, message: 'no model' }), /no model/)
  assert.match(writerErrorMessage(new Error('boom')), /boom/)
})

await check('the native panel mirrors the sidebar as five tabs inside the budget', async () => {
  for (const locale of ['zh', 'en']) {
    const view = nativePanelView({ ...STUDIO_CAPS, locale })
    const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
    const stats = viewStats(view)
    assert.ok(bytes <= 32 * 1024, `${locale}: ${bytes} bytes`)
    assert.ok(stats.nodes <= 120, `${locale}: ${stats.nodes} nodes`)
    assert.ok(stats.depth <= 8, `${locale}: depth ${stats.depth}`)
    const nodes = collectNodes(view)
    const tabs = nodes.find((node) => node.type === 'tabs')
    assert.ok(tabs, 'the panel must use tabs')
    assert.equal(tabs.items.length, 5)
    for (const item of tabs.items) assert.ok(String(item.label ?? '').length > 0)
    const forms = nodes.filter((node) => node.type === 'form').map((node) => node.submit)
    assert.deepEqual(forms.sort(), ['generate', 'saveSettings'])
    for (const input of nodes.filter((node) => node.bind)) assert.match(input.bind, /^data\.(form|writer|edit|lib|settings)\.[A-Za-z0-9]+$/)
  }
})

await check('an empty component list means unknown, not unsupported', () => {
  const view = nativePanelView({ locale: 'zh', components: [] })
  assert.equal(view.v, 2)
  assert.ok(collectNodes(view).some((node) => node.type === 'form'))
  const explicit = nativePanelView({ locale: 'zh', components: ['stack', 'text', 'callout'] })
  assert.equal(explicit.v, 1)
})

await check('the native panel degrades to v1 on an app without inputs', async () => {
  const view = nativePanelView({ locale: 'zh', components: ['stack', 'text', 'callout', 'list', 'actions'] })
  assert.equal(view.v, 1)
  assert.ok(!collectNodes(view).some((node) => node.type === 'form'))
})

await check('the AI writer capsule prefills the workbench draft and opens it', async () => {
  const panels = await capturePanels()
  const handler = panels.handlers.get('nai-writer')
  assert.equal(typeof handler, 'function', 'the capsule handler must be registered')

  const effect = handler({ sessionId: 'capsule-test', draft: '雨后的屋顶，少女坐着' })
  assert.equal(effect.open, 'panel:novelai')
  assert.match(String(effect.toast ?? ''), /已带上/)

  const studio = panels.get('novelai')
  const emitted = []
  const stop = studio.data({ sessionId: 'capsule-test' }, (data) => emitted.push(data), { locale: 'zh' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  stop()
  assert.equal(emitted.at(-1).writer.text, '雨后的屋顶，少女坐着')

  // Without a draft it still opens the workbench.
  const empty = handler({ sessionId: 'capsule-empty', draft: '' })
  assert.equal(empty.open, 'panel:novelai')
  assert.match(String(empty.toast ?? ''), /工作台/)
})

await check('the nai_write_prompt tool is registered and validates its input', async () => {
  const tools = await captureTools()
  const tool = tools.get('nai_write_prompt')
  assert.ok(tool, 'nai_write_prompt must be registered')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['natural_language'])
  // defineTool validates required arguments before the body runs.
  await assert.rejects(
    () => tool.execute({}, { signal: new AbortController().signal }),
    /natural_language/
  )
  // An empty sentence reaches the writer and is refused there.
  await assert.rejects(
    () => tool.execute({ natural_language: '' }, { signal: new AbortController().signal }),
    /写一句/
  )
})

await check('the writer action validates its draft and can be cancelled', async () => {
  const panels = await capturePanels()
  const studio = panels.get('novelai')
  const scope = { sessionId: 'studio-test-writer' }

  studio.actions.changed(scope, { value: { bind: 'data.writer.text', value: '雨后的屋顶，少女坐着' } })
  const emitted = []
  const stop = studio.data(scope, (data) => emitted.push(data), { locale: 'zh' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  stop()
  assert.equal(emitted.at(-1).writer.text, '雨后的屋顶，少女坐着')

  const empty = await studio.actions.write({ sessionId: 'studio-test-writer-empty' }, { value: {} })
  assert.match(String(empty.toast ?? ''), /描述/)

  const cancel = studio.actions.cancelWrite({ sessionId: 'studio-test-writer-empty' })
  assert.match(String(cancel.toast ?? ''), /没有正在写词/)
})

await check('the dsh-go tool cards fit the card budget', async () => {
  const longPrompt = 'masterpiece, '.repeat(1000)
  const generated = toolCard((_args, value) => generateView(value))({}, {
    request: { width: 832, height: 1216, steps: 28, model: 'nai-diffusion-5-full', sampler: 'k_euler_ancestral', scale: 5, prompt: longPrompt },
    files: Array.from({ length: 8 }, (_, index) => ({ file: `2026-11-07T00-00-0${index}Z.png`, bytes: 1_600_000, seed: 123 + index })),
    weight: 1,
    artist: '色色3',
    block: { notes: ['画师串占正向 89%'] },
    logId: 'abc123'
  })
  assert.ok(generated['dsh-go/view'], 'the generate card should be produced')
  assert.ok(Buffer.byteLength(JSON.stringify(generated), 'utf8') <= 8 * 1024)
  const probe = toolCard((_args, value) => probeView(value))({}, {
    ok: true,
    detail: '凭据有效（HTTP 200）',
    status: 200,
    origin: 'https://nai.nailong.win',
    subscription: { tier: 3, active: true, anlas: { total: 10692, fixed: 3631, purchased: 7061 }, energy: { percent: 99 } }
  })
  assert.ok(probe['dsh-go/view'])
  assert.ok(Buffer.byteLength(JSON.stringify(probe), 'utf8') <= 8 * 1024)
  const estimate = toolCard((_args, value) => estimateView(value))({}, { width: 832, height: 1216, steps: 28, nSamples: 1, weight: 1, perImage: 1, free: true })
  assert.ok(estimate['dsh-go/view'])
  assert.ok(Buffer.byteLength(JSON.stringify(estimate), 'utf8') <= 8 * 1024)
})

await check('the dsh-go strip text stays within 24 characters', async () => {
  const filled = stripText({ balance: { totalText: '10,692', energyText: '99%', tone: 'good' } }, { locale: 'zh' })
  assert.ok(filled.text.length <= 24, filled.text)
  assert.ok(filled.text.includes('99%'), filled.text)
  assert.equal(stripText(null, { locale: 'zh' }).text, 'NAI · 未检测')
  assert.equal(stripText(null, { locale: 'en' }).text, 'NAI · not checked')
})

await check('the dsh-go list items carry their actions', async () => {
  const { characterItems, recentItems } = listItems(
    [{ id: 'c1', name: '简', group: '默认分组', keywords: ['简', 'jane'], insertText: '简, jane, ' }],
    [{ name: 'a.png', bytes: 1024, when: '11-07 00:10', path: '/x/a.png' }]
  )
  assert.equal(characterItems[0].action.id, 'useCharacter')
  assert.deepEqual(characterItems[0].action.args, { id: 'c1' })
  assert.equal(recentItems[0].action.id, 'copyFile')
  assert.equal(recentItems[0].action.args.path, '/x/a.png')
  assert.ok(recentItems[0].subtitle.includes('1.0 KB'), recentItems[0].subtitle)
  assert.equal(formatBytes(0), '—')
})

// ------------------------------------------------------------ host routes --
/**
 * Mount the Host half on a fake context and return the captured API handler.
 *
 * This is the only way to exercise the route table without a running DSH: the
 * handler is a closure registered through `ctx.webServer.register`, so capturing
 * it is exactly what the host would do.
 * @returns {Promise<Function>} the `/nai-imagegen/api` handler.
 */
async function captureHandler() {
  let handler = null
  const ctx = {
    tools: { register: () => () => {} },
    effect: (fn) => {
      fn()
      return () => {}
    },
    webServer: {
      register: (spec) => {
        if (spec.path === '/nai-imagegen/api') handler = spec.handler
        return () => {}
      }
    }
  }
  apply(ctx)
  assert.equal(typeof handler, 'function', 'the API handler should have been registered')
  return handler
}

/**
 * Drive one request through the captured handler.
 * @param handler - the API handler.
 * @param options - `{ method, url }`.
 * @returns the captured status, headers and body.
 */
async function call(handler, { method = 'GET', url, body = null }) {
  const response = {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk
    }
  }
  // `readJsonBody` consumes the request as an async iterable, which is what a
  // real node request is; the fake has to offer the same shape.
  const request = {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      if (body === null) return
      yield Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    }
  }
  await handler(request, response)
  return response
}

const handler = await captureHandler()

await check('GET /status is routed and exposes the source directory', async () => {
  const response = await call(handler, { url: '/nai-imagegen/api/status' })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(typeof body.sourceDir, 'string')
  assert.ok(body.sourceDir.length > 0)
  // The transcript scanner is opt-in; the panel needs the flag to render its toggle.
  assert.equal(typeof body.codeButtons, 'boolean')
})

await check('GET /sources is routed and returns a file list', async () => {
  const response = await call(handler, { url: '/nai-imagegen/api/sources' })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(typeof body.sourceDir, 'string')
  assert.ok(Array.isArray(body.files))
})

await check('GET /sources paginates with total/hasMore and honours offset', async () => {
  const page = await call(handler, { url: '/nai-imagegen/api/sources?limit=1&offset=0' })
  assert.equal(page.status, 200)
  const body = JSON.parse(page.body)
  assert.ok(body.files.length <= 1)
  assert.ok(body.total >= body.files.length)
  assert.equal(typeof body.hasMore, 'boolean')
  const next = await call(handler, { url: '/nai-imagegen/api/sources?limit=1&offset=1' })
  assert.equal(next.status, 200)
  const nextBody = JSON.parse(next.body)
  assert.ok(nextBody.files.length <= 1)
  // Offset must move past the first row, so the second page cannot repeat it.
  if (body.files.length === 1 && nextBody.files.length === 1) {
    assert.notEqual(body.files[0].name, nextBody.files[0].name)
  }
})

await check('GET /source-file rejects a path traversal name', async () => {
  const response = await call(handler, { url: '/nai-imagegen/api/source-file?name=..%2Fescaped.png' })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /path/)
})

await check('POST /generate forwards a base image name into the img2img path', async () => {
  // A missing base image fails inside readBaseImage before any network call, so
  // this proves the route hands sourceImage to renderNow without spending quota.
  const response = await call(handler, {
    method: 'POST',
    url: '/nai-imagegen/api/generate',
    body: JSON.stringify({
      prompt: 'x',
      sourceImage: '__definitely_missing__.png',
      width: 832,
      height: 1216
    })
  })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /底图不存在/)
})

await check('POST /source-upload rejects a non-image body without writing a file', async () => {
  const before = await call(handler, { url: '/nai-imagegen/api/sources?limit=200' })
  const beforeNames = JSON.parse(before.body).files.map((file) => file.name).sort()
  const response = await call(handler, {
    method: 'POST',
    url: '/nai-imagegen/api/source-upload?name=probe-not-an-image.txt',
    body: Buffer.from('definitely not an image')
  })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /PNG\/JPEG\/WebP/)
  const after = await call(handler, { url: '/nai-imagegen/api/sources?limit=200' })
  assert.deepEqual(
    JSON.parse(after.body).files.map((file) => file.name).sort(),
    beforeNames
  )
})

await check('POST /source-upload stores a picked PNG in the source directory', async () => {
  const png = makePng(16, 16)
  const response = await call(handler, {
    method: 'POST',
    url: '/nai-imagegen/api/source-upload?name=__verify-upload.png',
    body: png
  })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  // The extension is forced from the sniffed MIME type, not taken on trust.
  assert.match(body.name, /^__verify-upload.*\.png$/)
  assert.equal(body.mime, 'image/png')
  const listed = await call(handler, { url: '/nai-imagegen/api/sources?limit=200' })
  const listing = JSON.parse(listed.body)
  assert.ok(listing.files.some((file) => file.name === body.name))
  // Clean up: a verification run must not leave an artifact in the real source
  // directory it wrote to.
  await rm(join(listing.sourceDir, body.name), { force: true })
})

await check('infill payload carries image, mask, original-image flag and strength', () => {
  const body = buildPayload({
    ...base,
    model: 'nai-diffusion-4-5-full-inpainting',
    action: 'infill',
    image: 'QUJD',
    mask: 'REVG',
    addOriginalImage: true,
    inpaintStrength: 1.7
  })
  assert.equal(body.action, 'infill')
  assert.equal(body.parameters.image, 'QUJD')
  assert.equal(body.parameters.mask, 'REVG')
  assert.equal(body.parameters.add_original_image, true)
  // Clamped to the documented 0..1 range.
  assert.equal(body.parameters.inpaint_img2img_strength, 1)
})

await check('infill payload refuses to build without a mask', () => {
  assert.throws(() => buildPayload({ ...base, action: 'infill', image: 'QUJD' }), /requires a mask/)
})

await check('POST /inpaint rejects a non-PNG mask', async () => {
  const png = makePng(64, 64).toString('base64')
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
  const response = await call(handler, {
    method: 'POST',
    url: '/nai-imagegen/api/inpaint',
    body: JSON.stringify({
      prompt: 'x',
      width: 64,
      height: 64,
      base: `data:image/png;base64,${png}`,
      mask: `data:image/jpeg;base64,${jpeg}`
    })
  })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /mask 必须是 PNG/)
})

await check('POST /inpaint rejects a mask whose size differs from the canvas', async () => {
  const base64 = makePng(64, 64).toString('base64')
  const mask = makePng(32, 32).toString('base64')
  const response = await call(handler, {
    method: 'POST',
    url: '/nai-imagegen/api/inpaint',
    body: JSON.stringify({
      prompt: 'x',
      width: 64,
      height: 64,
      base: `data:image/png;base64,${base64}`,
      mask: `data:image/png;base64,${mask}`
    })
  })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /蒙版尺寸/)
})

await check('POST /director rejects an unsupported tool', async () => {
  const response = await call(handler, {
    method: 'POST',
    url: '/nai-imagegen/api/director',
    body: JSON.stringify({ name: 'whatever.png', type: 'bg-removal' })
  })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /不支持的导演工具/)
})

await check('POST /director rejects a missing image without touching the network', async () => {
  const response = await call(handler, {
    method: 'POST',
    url: '/nai-imagegen/api/director',
    body: JSON.stringify({ name: '__definitely_missing__.png', type: 'lineart' })
  })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /missing|ENOENT|no such file/i)
})

await check('POST /characters/ai-edit requires an instruction', async () => {
  const response = await call(handler, {
    method: 'POST',
    url: '/nai-imagegen/api/characters/ai-edit',
    body: JSON.stringify({ instruction: '   ' })
  })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /先写一句/)
})

await check('GET /render-progress answers unknown ids without failing', async () => {
  const response = await call(handler, { url: '/nai-imagegen/api/render-progress?id=nope' })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).status, 'unknown')
})

// --------------------------------------------------------------------- report --
if (failures.length > 0) {
  console.error(`\n${passed} passed, ${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\n${passed} passed`)
}
