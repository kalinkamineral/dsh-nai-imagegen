/**
 * dsh-nai-imagegen — offline checks for the workbench's host half.
 *
 * Covers the prompt writer (flat grammar, JSON fallback, corrective retry), DNA
 * from a reference picture, the character / market / user-artist / preset
 * routes, keyword substitution and the new sampling knobs on the render path,
 * and `/file-meta`.
 *
 * Fully isolated: `DSH_HOME` points at a temp directory **before** any plugin
 * module is imported (the state directory is fixed at import time), NovelAI is
 * a local HTTP server, and DSH's `llm` / `attachments` services are fakes. No
 * network, no credential, no write outside the temp directory.
 *
 * Run with `node tests/workbench-host-probe.mjs`.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

// ------------------------------------------------------------- isolation --
const home = await mkdtemp(join(tmpdir(), 'nai-wb-'))
process.env.DSH_HOME = home
delete process.env.NAI_TOKEN
const stateDir = join(home, 'nai-imagegen')
const outputDir = join(home, 'out')
const sourceDir = join(home, 'in')
const artistIndex = join(stateDir, 'artists', 'index.json')
await mkdir(stateDir, { recursive: true })
await mkdir(outputDir, { recursive: true })
await mkdir(sourceDir, { recursive: true })

// ------------------------------------------------------------------ PNGs --
/** @returns one PNG chunk. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

/**
 * A valid RGB PNG, optionally carrying a NovelAI-style `Comment` tEXt chunk.
 * @returns the PNG bytes.
 */
function makePng(width, height, comment = null, fill = 0) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((1 + width * 3) * height, fill)
  const chunks = [pngChunk('IHDR', ihdr)]
  if (comment !== null) chunks.push(pngChunk('tEXt', Buffer.from(`Comment\u0000${JSON.stringify(comment)}`, 'latin1')))
  chunks.push(pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

// ------------------------------------------------------- fake NovelAI --
/** Every request body the fake received, newest last. */
const naiBodies = []
/** When true, renders are accepted and never answered (a stuck upstream). */
let naiHangRenders = false
/** Responses held open by the hang mode; `closed` flips when the client hangs up. */
const naiHeld = []
const nai = createServer((req, res) => {
  // The free subscription read answers at once, even while renders hang.
  if (req.method === 'GET' && req.url === '/user/subscription') {
    const text = JSON.stringify({
      tier: 3,
      active: true,
      trainingStepsLeft: { fixedTrainingStepsLeft: 1000, purchasedTrainingSteps: 250 },
      usage: { percent: 80, isNegative: false, timeUntilNextPercent: 90 }
    })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    if (naiHangRenders) {
      const held = { res, closed: false }
      res.on('close', () => {
        held.closed = true
      })
      naiHeld.push(held)
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    naiBodies.push(body)
    const p = body.parameters ?? {}
    // Real output records the seed it used in the PNG comment.
    const png = makePng(8, 8, { seed: p.seed ?? 777, steps: p.steps, width: p.width, height: p.height, scale: p.scale })
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length })
    res.end(png)
  })
})
await new Promise((resolve) => nai.listen(0, '127.0.0.1', resolve))
const naiPort = nai.address().port

await writeFile(
  join(stateDir, 'config.json'),
  JSON.stringify({
    baseUrl: `http://127.0.0.1:${naiPort}`,
    token: 'fake-test-token',
    proxy: 'off',
    outputDir,
    sourceDir,
    artistIndex,
    libraryDir: join(home, 'lib'),
    librarySourceDir: join(home, 'lib-src'),
    model: 'nai-diffusion-5-full'
  }),
  'utf8'
)

// An archive with two entries, indexed the way import-artists.mjs does it.
const archive = join(home, 'archive.json')
const archivePng = makePng(4, 4, null, 0x33)
await writeFile(
  archive,
  JSON.stringify([
    { name: '甜彩', sequence: 0, positivePrompt: 'artist:sweet', negativePrompt: 'ugly', referenceImage: `data:image/png;base64,${archivePng.toString('base64')}` },
    { name: '古风', sequence: 1, positivePrompt: 'artist:old', negativePrompt: '', referenceImage: '' }
  ]),
  'utf8'
)

// ---------------------------------------------------------------- imports --
const { buildIndex } = await import('../lib/artists.js')
await buildIndex({ sourceFile: archive, indexPath: artistIndex })
const writer = await import('../lib/writer.js')
const { apply } = await import('../index.js')

// ------------------------------------------------------------- fake DSH --
/** What the fake model saw, one entry per `stream()` call. */
const llmCalls = []
/**
 * A fake `llm` service whose replies come from a queue.
 * @param replies - reply texts (or functions of the request returning one).
 * @param options - `{ vision }`.
 */
function fakeLlm(replies, { vision = true } = {}) {
  const queue = [...replies]
  return {
    async *stream(request) {
      llmCalls.push(request)
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next === 'WAIT_FOR_ABORT') {
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
        return
      }
      const text = typeof next === 'function' ? next(request) : String(next)
      // Streamed in pieces, as the host does.
      for (let i = 0; i < text.length; i += 7) yield { type: 'text-delta', index: 0, text: text.slice(i, i + 7) }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    async resolveModelInfo() {
      return { inputModalities: vision ? ['text', 'image'] : ['text'] }
    },
    async listProviders() {
      return [{ provider: 'not', displayName: 'Not' }]
    },
    async listModels() {
      return [{ id: 'claude-opus-5-5', name: 'Opus', inputModalities: ['text', 'image'] }, { id: 'text-only' }]
    }
  }
}
const services = {
  llm: fakeLlm(['scene: x']),
  agentDefaultModel: { currentSelection: () => ({ provider: 'not', model: 'claude-opus-5-5' }) },
  attachments: {
    saved: [],
    async saveImage(input) {
      this.saved.push(input)
      return { attachmentId: `att-${this.saved.length}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
    }
  }
}

let handler = null
apply({
  get: (name) => services[name],
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
})
assert.equal(typeof handler, 'function')

/**
 * Drive one request through the handler.
 * @returns `{ status, headers, body, json }`, plus the response emitter.
 */
async function call(method, path, body = null, { beforeEnd } = {}) {
  const res = Object.assign(new EventEmitter(), {
    status: 0,
    headers: null,
    body: null,
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      this.body = chunk
      this.writableEnded = true
    }
  })
  const req = {
    url: `/nai-imagegen/api${path}`,
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    }
  }
  const pending = handler(req, res)
  if (beforeEnd) await beforeEnd(res)
  await pending
  let json = null
  try {
    json = JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body))
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, body: res.body, json }
}

let passed = 0
const failures = []
/** Run one named check. */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}\n  ${error?.stack ?? error}`)
  }
}

try {
  // ---------------------------------------------------------- flat parser --
  await check('flat parser: bullets, bold, full-width colon, multi-line analysis', () => {
    const text = [
      '好的，下面是提示词：',
      '- **analysis**：画面是两人在公园',
      'foreground: 长椅',
      '第二行分析',
      '**scene**: 2girls, park, 2::in frame::',
      'artist:foo, sunny',
      'Note: this line ends the scene',
      'scene_uc：lowres',
      '* char: 0.3, 0.6 | 1girl, blonde hair',
      'char_uc: black hair',
      'char: 1girl, black hair',
      'char_uc: blonde hair'
    ].join('\n')
    const parsed = writer.parseWriterReply(text)
    assert.equal(parsed.ok, true, parsed.issues.join('; '))
    assert.equal(parsed.source, 'flat')
    assert.equal(parsed.analysis, '画面是两人在公园\nforeground: 长椅\n第二行分析')
    assert.equal(parsed.caption.base, '2girls, park, 2::in frame::\nartist:foo, sunny')
    assert.equal(parsed.caption.baseNegative, 'lowres')
    assert.deepEqual(parsed.caption.characters[0], { positive: '1girl, blonde hair', negative: 'black hair', center: { x: 0.3, y: 0.6 } })
    // A char without coordinates lands in the centre.
    assert.deepEqual(parsed.caption.characters[1].center, { x: 0.5, y: 0.5 })
    assert.equal(parsed.size, null)
  })

  await check('flat parser: --- separates blocks and the first block with content wins', () => {
    const parsed = writer.parseWriterReply('analysis: only analysis\n---\nscene: first\n---\nscene: second')
    assert.equal(parsed.caption.base, 'first')
  })

  await check('flat parser: size 1216×832 / 1216x832, out-of-range coordinates clamp', () => {
    assert.deepEqual(writer.parseWriterReply('size: 1216×832\nscene: a').size, { width: 1216, height: 832 })
    assert.deepEqual(writer.parseWriterReply('size: 1216X832\nscene: a').size, { width: 1216, height: 832 })
    const clamped = writer.parseWriterReply('scene: a\nchar: 1.4,-2 | x\nchar_uc: ')
    assert.deepEqual(clamped.caption.characters[0].center, { x: 1, y: 0 })
  })

  await check('flat parser: validation reports unpaired char_uc and a bad size', () => {
    const unpaired = writer.parseWriterReply('scene: a\nchar: x\nchar: y\nchar_uc: z')
    assert.equal(unpaired.ok, false)
    assert.match(unpaired.issues.join(), /char 有 2 行、char_uc 有 1 行/)
    const badSize = writer.parseWriterReply('size: big\nscene: a')
    assert.equal(badSize.ok, false)
    assert.match(badSize.issues.join(), /宽x高/)
    assert.equal(writer.parseWriterReply('just chatting, no fields').ok, false)
  })

  await check('flat parser: more than six characters are truncated with a note', () => {
    const lines = ['scene: crowd']
    for (let i = 0; i < 8; i += 1) lines.push(`char: c${i}`, `char_uc: u${i}`)
    const parsed = writer.parseWriterReply(lines.join('\n'))
    assert.equal(parsed.ok, true)
    assert.equal(parsed.caption.characters.length, 6)
    assert.match(parsed.notes.join(), /截断/)
  })

  await check('JSON fallbacks: {caption:{v4_prompt…}}, 生图内容, bare v4, own shape', () => {
    const v4 = {
      v4_prompt: { caption: { base_caption: 'a {brace} b', char_captions: [{ char_caption: 'x', centers: [{ x: 0.2, y: 0.8 }] }] } },
      v4_negative_prompt: { caption: { base_caption: 'n', char_captions: [{ char_caption: 'nx' }] } }
    }
    const wrapped = writer.parseWriterReply(`好的\n\`\`\`json\n${JSON.stringify({ caption: v4 })}\n\`\`\``)
    assert.equal(wrapped.source, 'json')
    assert.equal(wrapped.caption.base, 'a {brace} b')
    assert.deepEqual(wrapped.caption.characters[0], { positive: 'x', negative: 'nx', center: { x: 0.2, y: 0.8 } })
    const chinese = writer.parseWriterReply(`前言 ${JSON.stringify({ 生图内容: v4, size: '1216x832' })} 后记`)
    assert.equal(chinese.caption.base, 'a {brace} b')
    assert.deepEqual(chinese.size, { width: 1216, height: 832 })
    assert.equal(writer.parseWriterReply(JSON.stringify(v4)).caption.baseNegative, 'n')
    const own = writer.parseWriterReply(JSON.stringify({ base: 'b', baseNegative: 'bn', characters: [{ positive: 'p', negative: 'q', center: { x: 0.1, y: 0.2 } }] }))
    assert.deepEqual(own.caption, { base: 'b', baseNegative: 'bn', characters: [{ positive: 'p', negative: 'q', center: { x: 0.1, y: 0.2 } }] })
  })

  await check('renderTemplate replaces known variables in one pass and keeps unknown ones', () => {
    assert.equal(writer.renderTemplate('{{a}} {{b}} {{x}}', { a: '{{b}}', b: 'B' }), '{{b}} B {{x}}')
  })

  // ---------------------------------------------------------- model routes --
  await check('GET /llm/status and /llm/models go through the root ctx', async () => {
    const status = await call('GET', '/llm/status')
    assert.equal(status.status, 200)
    assert.deepEqual(
      { available: status.json.available, provider: status.json.provider, model: status.json.model, source: status.json.source, vision: status.json.vision },
      { available: true, provider: 'not', model: 'claude-opus-5-5', source: 'dsh-default', vision: true }
    )
    const models = await call('GET', '/llm/models')
    assert.equal(models.json.providers[0].provider, 'not')
    assert.equal(models.json.providers[0].models[0].vision, true)
  })

  // ------------------------------------------------------------ characters --
  let groupId
  let aliceId
  await check('character routes: group, save, list, export, import round trip', async () => {
    const group = await call('POST', '/characters/group', { group: { name: '主角' } })
    assert.equal(group.status, 200)
    groupId = group.json.doc.groups.find((row) => row.name === '主角').id
    const saved = await call('POST', '/characters/save', {
      character: { groupId, name: 'Alice', keywords: 'Alice, 爱丽丝', fixedFeatures: '1girl, blonde hair, blue eyes', variableFeatures: [{ name: '日常', prompt: 'white blouse' }] }
    })
    assert.equal(saved.status, 200)
    aliceId = saved.json.character.id
    assert.deepEqual(saved.json.character.keywords, ['Alice', '爱丽丝'])
    const listed = await call('GET', '/characters')
    assert.ok(listed.json.characters.some((row) => row.id === aliceId))
    const exported = await call('GET', `/characters/export?group=${encodeURIComponent(groupId)}`)
    assert.equal(exported.status, 200)
    assert.match(exported.headers['Content-Disposition'], /attachment; filename="nai-characters.json"/)
    const payload = JSON.parse(exported.body)
    assert.equal(payload.kind, 'character')
    assert.equal(payload.characters.length, 1)
    // Re-importing with `skip` changes nothing; with `rename` adds a copy.
    const skipped = await call('POST', '/characters/import', { payload, onDuplicate: 'skip' })
    assert.equal(skipped.json.skipped, 1)
    const renamed = await call('POST', '/characters/import', { payload: JSON.stringify(payload), onDuplicate: 'rename' })
    assert.equal(renamed.json.renamed, 1)
    const copy = renamed.json.doc.characters.find((row) => row.name === 'Alice · 导入副本')
    assert.ok(copy, 'the renamed copy exists')
    const copyGroup = renamed.json.doc.groups.find((row) => row.id === copy.groupId)
    assert.equal(copyGroup.name, '主角 · 导入副本')
    // Clean the copy up again so it does not take part in keyword substitution.
    await call('POST', '/characters/group/delete', { id: copyGroup.id })
    const after = await call('GET', '/characters')
    assert.equal(after.json.characters.filter((row) => row.name.startsWith('Alice')).length, 1)
  })

  await check('character import accepts nai-dbgen\'s envelope and refuses another kind', async () => {
    const envelope = {
      schemaVersion: 1,
      kind: 'character',
      exportedAt: new Date().toISOString(),
      groups: [{ schemaVersion: 1, id: 'cg_x', name: 'dbgen', active: false, order: 3 }],
      characters: [{ schemaVersion: 1, id: 'ch_x', groupId: 'cg_x', name: 'Bob', keywords: ['Bob'], fixedFeatures: '1boy', variableFeatures: [], matchOverrides: null }]
    }
    const imported = await call('POST', '/characters/import', { payload: envelope })
    assert.equal(imported.status, 200)
    assert.equal(imported.json.imported, 1)
    assert.equal(imported.json.doc.groups.find((row) => row.id === 'cg_x').active, false)
    const wrong = await call('POST', '/characters/import', { payload: { kind: 'tag', entries: [], characters: [{}] } })
    assert.equal(wrong.status, 400)
    assert.match(wrong.json.error, /不是角色库文件/)
  })

  // ---------------------------------------------------------------- write --
  await check('POST /write: empty input is refused', async () => {
    const response = await call('POST', '/write', { naturalLanguage: '  ' })
    assert.equal(response.status, 400)
    assert.equal(response.json.error, '写一句想要的画面，或者附一张参考图')
  })

  await check('POST /write: blocks, matched characters, streamed reply', async () => {
    llmCalls.length = 0
    services.llm = fakeLlm(['analysis: 公园\nscene: park, day\nscene_uc: lowres\nchar: 0.4,0.5 | Alice, sitting\nchar_uc: black hair\nsize: 1216x832'])
    const response = await call('POST', '/write', {
      naturalLanguage: '爱丽丝坐在公园',
      references: [{ library: '标签库9.5', title: '公园', content: 'park/garden, bench' }],
      characterIds: ['ch_x']
    })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.deepEqual(response.json.caption.characters[0], { positive: 'Alice, sitting', negative: 'black hair', center: { x: 0.4, y: 0.5 } })
    assert.deepEqual(response.json.size, { width: 1216, height: 832 })
    assert.deepEqual(response.json.matchedCharacters, ['Alice', 'Bob'])
    assert.deepEqual(response.json.route, { provider: 'not', model: 'claude-opus-5-5' })
    assert.equal(response.json.attempts, 1)
    const sent = llmCalls[0]
    const userText = sent.messages[0].content[0].text
    assert.match(userText, /【Alice】\n固定特征：1girl, blonde hair, blue eyes/)
    assert.match(userText, /【标签库9.5 · 公园】\npark\/garden, bench/)
    assert.match(userText, /832×1216/)
    assert.match(sent.system, /【标签库用法】/)
    assert.match(sent.system, /画师 \/ 风格串由插件在出图时另行拼接，本输出不要写画师串/)
    assert.equal(sent.messages[0].content.length, 1, 'no image part without an image')
  })

  await check('POST /write: a bad reply is retried with the correction, then accepted', async () => {
    llmCalls.length = 0
    services.llm = fakeLlm(['I would draw a park.', 'scene: park\nchar: x\nchar: y\nchar_uc: a', 'scene: park\nscene_uc: lowres'])
    const response = await call('POST', '/write', { naturalLanguage: 'a park' })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json.attempts, 3)
    assert.equal(response.json.caption.base, 'park')
    const retry = llmCalls[2].messages[0].content[0].text
    assert.match(retry, /======== 上一轮回复（未通过程序校验）========\nscene: park\nchar: x/)
    assert.match(retry, /上一次生图结果未通过程序校验（WORKBENCH_CAPTION_INVALID）/)
    assert.match(retry, /- char 有 2 行、char_uc 有 1 行/)
  })

  await check('POST /write: retries exhausted → 422 with the issues and the raw reply', async () => {
    services.llm = fakeLlm(['no fields here'])
    await call('POST', '/config', { writerRetries: 1 })
    llmCalls.length = 0
    const response = await call('POST', '/write', { naturalLanguage: 'a park' })
    assert.equal(response.status, 422)
    assert.equal(response.json.code, 'WORKBENCH_CAPTION_INVALID')
    assert.equal(response.json.attempts, 2)
    assert.equal(response.json.raw, 'no fields here')
    assert.equal(llmCalls.length, 2)
    await call('POST', '/config', { writerRetries: 2 })
  })

  await check('POST /write: reverse prompt appends the reference note and sends the image', async () => {
    llmCalls.length = 0
    services.llm = fakeLlm(['scene: from the picture'])
    const image = `data:image/png;base64,${makePng(4, 4).toString('base64')}`
    const response = await call('POST', '/write', { naturalLanguage: '', image })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    const content = llmCalls[0].messages[0].content
    assert.ok(content[0].text.endsWith(`\n\n${writer.REFERENCE_NOTE}`))
    assert.equal(content[1].type, 'image')
    assert.equal(content[1].attachment.mediaType, 'image/png')
  })

  await check('POST /write: closing the response aborts the model call', async () => {
    services.llm = fakeLlm(['WAIT_FOR_ABORT'])
    llmCalls.length = 0
    const response = await call('POST', '/write', { naturalLanguage: 'x' }, {
      beforeEnd: async (res) => {
        while (llmCalls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
        res.emit('close')
      }
    })
    assert.equal(llmCalls[0].signal.aborted, true)
    assert.notEqual(response.status, 200)
  })

  // ------------------------------------------------------------------ DNA --
  await check('POST /characters/from-image: draft from a vision model, one retry on no JSON', async () => {
    llmCalls.length = 0
    services.llm = fakeLlm([
      'Sorry, here you go: it is Miku.',
      '```json\n{"name":"初音未来","keywords":["初音","miku"],"fixedFeatures":"hatsune miku, vocaloid, aqua hair, twintails","variableFeatures":[{"name":"参考图服装","prompt":"sleeveless shirt, detached sleeves"}],"negative":"","notes":"较确定"}\n```'
    ])
    const image = `data:image/png;base64,${makePng(4, 4).toString('base64')}`
    const response = await call('POST', '/characters/from-image', { image, hint: '是初音' })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json.draft.name, '初音未来')
    assert.deepEqual(response.json.draft.keywords, ['初音', 'miku'])
    assert.equal(response.json.draft.variableFeatures[0].name, '参考图服装')
    assert.equal(llmCalls.length, 2)
    assert.match(llmCalls[0].messages[0].content[0].text, /是初音/)
    assert.equal(llmCalls[0].messages[0].content[1].type, 'image')
    assert.match(llmCalls[0].system, /fixedFeatures 里不要写服装/)
  })

  await check('POST /characters/from-image: refuses a model that cannot see images', async () => {
    services.llm = fakeLlm(['{}'], { vision: false })
    const image = `data:image/png;base64,${makePng(4, 4).toString('base64')}`
    const response = await call('POST', '/characters/from-image', { image })
    assert.equal(response.status, 400)
    assert.match(response.json.error, /不能看图/)
    assert.match(response.json.error, /插件的「模型」设置/)
  })

  // -------------------------------------------------------------- presets --
  await check('preset routes: override a field, read it back, reset', async () => {
    const initial = await call('GET', '/presets')
    assert.equal(initial.json.presets.write.user, initial.json.defaults.write.user)
    const saved = await call('POST', '/presets', { write: { user: '{{用户描述}} only' } })
    assert.equal(saved.json.presets.write.user, '{{用户描述}} only')
    assert.equal(saved.json.presets.write.system, saved.json.defaults.write.system)
    const cleared = await call('POST', '/presets', { write: { user: '' } })
    assert.equal(cleared.json.presets.write.user, cleared.json.defaults.write.user)
    await call('POST', '/presets', { dna: { system: 'custom' } })
    const reset = await call('POST', '/presets/reset', { name: 'dna' })
    assert.equal(reset.json.presets.dna.system, reset.json.defaults.dna.system)
  })

  // ----------------------------------------------------------- generate --
  let galleryName
  await check('POST /generate: keyword substitution over the caption, no artist, sampling knobs', async () => {
    naiBodies.length = 0
    const response = await call('POST', '/generate', {
      caption: { base: 'Alice in a park', baseNegative: '', characters: [{ positive: 'Alice, sitting', negative: '', center: { x: 0.3, y: 0.5 } }] },
      replaceCharacterKeywords: true,
      artistOverride: null,
      model: 'nai-diffusion-4-5-full',
      cfgRescale: 0.4,
      noiseSchedule: 'exponential',
      variety: true,
      seed: 1234
    })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    const p = naiBodies[0].parameters
    assert.equal(p.v4_prompt.caption.char_captions[0].char_caption, '1girl, blonde hair, blue eyes, sitting')
    assert.match(p.v4_prompt.caption.base_caption, /^1girl, blonde hair, blue eyes in a park/)
    assert.doesNotMatch(JSON.stringify(p.v4_prompt), /Alice/)
    assert.deepEqual(p.v4_prompt.caption.char_captions[0].centers, [{ x: 0.3, y: 0.5 }])
    assert.equal(p.cfg_rescale, 0.4)
    assert.equal(p.noise_schedule, 'exponential')
    assert.ok(Math.abs(p.skip_cfg_above_sigma - Math.sqrt((832 * 1216) / 1011712) * 58) < 1e-9)
    assert.equal(response.json.files[0].seed, 1234)
    assert.deepEqual(response.json.replacedCharacters, ['Alice'])
    assert.equal(response.json.request.replaceCharacterKeywords, true)
    assert.equal(response.json.request.caption.base, 'Alice in a park', 'the sidecar keeps the caption as written')
    assert.equal(response.json.request.userPrompt, 'Alice in a park, Alice, sitting')
    galleryName = response.json.files[0].name
  })

  await check('POST /generate: artistOverride replaces the text; V5 forces karras and drops variety', async () => {
    naiBodies.length = 0
    const response = await call('POST', '/generate', {
      prompt: 'Alice, beach',
      replaceCharacterKeywords: false,
      artistOverride: { positivePrompt: 'artist:temp', negativePrompt: 'bad' },
      model: 'nai-diffusion-5-full',
      noiseSchedule: 'native',
      variety: true
    })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    const body = naiBodies[0]
    assert.match(body.input, /^artist:temp, Alice, beach/)
    assert.match(body.parameters.negative_prompt, /bad/)
    assert.equal(body.parameters.noise_schedule, 'karras')
    assert.equal(body.parameters.skip_cfg_above_sigma, undefined)
    assert.equal(body.parameters.cfg_rescale, 0)
    assert.equal(response.json.request.userPrompt, 'Alice, beach')
    // Unpinned: the seed comes back from the PNG's own metadata.
    assert.equal(response.json.files[0].seed, 777)
  })

  await check('POST /inpaint forwards caption, seed and substitution', async () => {
    naiBodies.length = 0
    const png = makePng(64, 64).toString('base64')
    const response = await call('POST', '/inpaint', {
      width: 64,
      height: 64,
      base: `data:image/png;base64,${png}`,
      mask: `data:image/png;base64,${png}`,
      caption: { base: 'beach', characters: [{ positive: 'Alice', center: { x: 0.5, y: 0.5 } }] },
      replaceCharacterKeywords: true,
      model: 'nai-diffusion-4-5-full',
      seed: 99
    })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(naiBodies[0].action, 'infill')
    assert.equal(naiBodies[0].model, 'nai-diffusion-4-5-full-inpainting')
    assert.equal(naiBodies[0].parameters.v4_prompt.caption.char_captions[0].char_caption, '1girl, blonde hair, blue eyes')
    assert.equal(response.json.files[0].seed, 99)
  })

  await check('GET /file-meta returns the sidecar and rejects traversal', async () => {
    const meta = await call('GET', `/file-meta?name=${encodeURIComponent(galleryName)}`)
    assert.equal(meta.status, 200)
    assert.equal(meta.json.request.caption.characters[0].positive, 'Alice, sitting')
    assert.equal(meta.json.files[0].name, galleryName)
    const traversal = await call('GET', '/file-meta?name=..%2Fnai-imagegen%2Fconfig.json')
    assert.equal(traversal.status, 400)
    assert.match(traversal.json.error, /path/)
    const missing = await call('GET', '/file-meta?name=__missing__.png')
    assert.equal(missing.status, 404)
  })

  // --------------------------------------------------------------- market --
  await check('market: invalid catalogs are refused with a Chinese list of problems', async () => {
    const before = await call('GET', '/market')
    assert.deepEqual(before.json, { catalog: null, signature: '' })
    const bad = await call('POST', '/market/import', {
      catalog: {
        kind: 'tag',
        libraries: [{ id: 'lib1', name: 'x' }, { id: 'lib1', name: 'dup' }],
        entries: [
          { id: 'e1', libraryId: 'lib1', key: '衬衫', value: 'shirt' },
          { id: 'e1', libraryId: 'nope', key: '服装·待分类', value: ' ' },
          { id: 'e3', libraryId: 'lib1', key: '待审核-服装·衬衫', value: 'x' }
        ]
      }
    })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /标签超市没有导入，共 \d+ 处问题/)
    assert.match(bad.json.error, /库 id 重复：lib1/)
    assert.match(bad.json.error, /至少要有「分类·名称」两段/)
    assert.match(bad.json.error, /尚未完成分类或命名审核/)
    assert.ok(bad.json.issues.some((line) => /value 为空/.test(line)))
    const empty = await call('POST', '/market/import', { catalog: { kind: 'tag', libraries: [], entries: [] } })
    assert.match(empty.json.error, /至少要有一条标签/)
    const notTag = await call('POST', '/market/import', { catalog: { kind: 'character', libraries: [], entries: [] } })
    assert.match(notTag.json.error, /kind 必须是 "tag"/)
  })

  await check('market: a valid catalog replaces the file and exports again', async () => {
    const catalog = {
      schemaVersion: 1,
      kind: 'tag',
      libraries: [{ id: 'lib1', name: '服装' }],
      entries: [
        { id: 'e1', libraryId: 'lib1', key: '服装·上衣·衬衫', value: 'white shirt' },
        { id: 'e2', libraryId: 'lib1', key: '服装·裙子', value: 'pleated skirt' }
      ]
    }
    const ok = await call('POST', '/market/import', { catalog })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.count, 2)
    assert.match(ok.json.signature, /^[0-9a-f]{12}$/)
    const got = await call('GET', '/market')
    assert.equal(got.json.signature, ok.json.signature)
    assert.deepEqual(got.json.catalog, catalog)
    const exported = await call('GET', '/market/export')
    assert.match(exported.headers['Content-Disposition'], /filename="nai-tag-market.json"/)
    assert.deepEqual(JSON.parse(exported.body), catalog)
  })

  // ---------------------------------------------------------- user artists --
  await check('user artists: create with a cover, list in the merged view, render with it', async () => {
    const created = await call('POST', '/artists/user/save', { name: '我的风格', positivePrompt: 'artist:mine', negativePrompt: 'blurry', coverFrom: galleryName })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    assert.equal(created.json.id, 100000)
    assert.equal(created.json.entry.user, true)
    assert.equal(created.json.entry.hasCover, true)
    const listing = await call('GET', '/artists?limit=10')
    assert.equal(listing.json.count, 3)
    const row = listing.json.artists.find((r) => r.id === 100000)
    assert.deepEqual({ user: row.user, hasThumb: row.hasThumb, hasImage: row.hasImage, group: row.group }, { user: true, hasThumb: true, hasImage: true, group: '我的画师串' })
    assert.deepEqual(listing.json.groups.at(-1), { group: '我的画师串', count: 1, user: true })
    const thumb = await call('GET', '/artist-image?id=100000&thumb=1')
    assert.equal(thumb.status, 200)
    assert.ok(thumb.body.equals(await readFile(join(outputDir, galleryName))))
    // Selected as the global style, it applies to a plain render.
    await call('POST', '/config', { artistId: 100000 })
    const status = await call('GET', '/status')
    assert.equal(status.json.artistName, '我的风格')
    assert.ok(status.json.artistGroups.some((g) => g.group === '我的画师串' && g.count === 1))
    naiBodies.length = 0
    const render = await call('POST', '/generate', { prompt: 'a cat' })
    assert.equal(render.status, 200, JSON.stringify(render.json))
    assert.match(naiBodies[0].input, /^artist:mine, a cat/)
    assert.equal(render.json.request.artistId, 100000)
  })

  await check('user artists: override an archive entry, replace its cover, revert', async () => {
    const edited = await call('POST', '/artists/user/save', { id: 0, name: '甜彩·改', positivePrompt: 'artist:sweet2', negativePrompt: '' })
    assert.equal(edited.json.entry.edited, true)
    assert.equal(edited.json.entry.name, '甜彩·改')
    // The archive picture still serves until a cover is set.
    const archived = await call('GET', '/artist-image?id=0')
    assert.ok(archived.body.equals(archivePng))
    const cover = await call('POST', '/artists/user/cover', { id: 1, from: galleryName })
    assert.equal(cover.json.entry.edited, true)
    assert.equal(cover.json.entry.name, '古风', 'a cover-only change keeps the archived text')
    assert.equal(cover.json.entry.hasCover, true)
    const covered = await call('GET', '/artist-image?id=1')
    assert.equal(covered.headers['Cache-Control'], 'no-cache')
    const traversal = await call('POST', '/artists/user/cover', { id: 1, from: '../config.json' })
    assert.equal(traversal.status, 400)
    const reverted = await call('POST', '/artists/user/delete', { id: 0 })
    assert.equal(reverted.json.removed, 'override')
    assert.equal(reverted.json.entry.name, '甜彩')
    assert.equal(reverted.json.entry.edited, false)
    const again = await call('POST', '/artists/user/delete', { id: 0 })
    assert.equal(again.status, 404)
  })

  await check('user artists: delete clears the selection and ids are never reused', async () => {
    const deleted = await call('POST', '/artists/user/delete', { id: 100000 })
    assert.equal(deleted.json.removed, 'entry')
    const config = await call('GET', '/config')
    assert.equal(config.json.artistId, -1)
    const gone = await call('GET', '/artist?id=100000')
    assert.equal(gone.status, 404)
    const next = await call('POST', '/artists/user/save', { name: '第二个' })
    assert.equal(next.json.id, 100001)
    const nameless = await call('POST', '/artists/user/save', { name: ' ' })
    assert.equal(nameless.status, 400)
    assert.equal(nameless.json.error, '请填写画师串名称')
  })

  // --------------------------------------------------------------- config --
  await check('config: the new fields are whitelisted, clamped and reported', async () => {
    const saved = await call('POST', '/config', { writerRetries: 9, cfgRescale: 3, noiseSchedule: 'bogus', variety: 'true' })
    assert.equal(saved.status, 200)
    const status = saved.json.status
    assert.equal(status.writerRetries, 5)
    assert.equal(status.cfgRescale, 1)
    assert.equal(status.noiseSchedule, 'karras')
    assert.equal(status.variety, true)
    assert.equal(status.llmProvider, '')
    assert.equal(status.llmMaxTokens, 4096)
    await call('POST', '/config', { writerRetries: 2, cfgRescale: 0, variety: false })
  })

  await check('透明底 is off by default and only on V5; SMEA only on V3', async () => {
    naiBodies.length = 0
    let response = await call('POST', '/generate', { prompt: '1girl, solo', model: 'nai-diffusion-5-full' })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    let p = naiBodies.at(-1).parameters
    assert.doesNotMatch(p.v4_prompt.caption.base_caption, /transparent background/, 'no transparent tag by default')
    assert.equal(p.straight_alpha, undefined)
    response = await call('POST', '/generate', { prompt: '1girl, solo', model: 'nai-diffusion-5-full', transparentBackground: true })
    p = naiBodies.at(-1).parameters
    assert.match(p.v4_prompt.caption.base_caption, /^transparent background, /)
    assert.equal(p.straight_alpha, true)
    assert.equal(p.tag_hint_transparent_background, true)
    response = await call('POST', '/generate', { prompt: '1girl, solo', model: 'nai-diffusion-4-5-full', transparentBackground: true })
    p = naiBodies.at(-1).parameters
    assert.doesNotMatch(p.v4_prompt.caption.base_caption, /transparent background/, 'V4.5 has no transparent mode')
    assert.equal(p.straight_alpha, undefined)
    response = await call('POST', '/generate', { prompt: '1girl, solo', model: 'nai-diffusion-3', smea: 'smea_dyn' })
    p = naiBodies.at(-1).parameters
    assert.equal(p.sm, true)
    assert.equal(p.sm_dyn, true)
    response = await call('POST', '/generate', { prompt: '1girl, solo', model: 'nai-diffusion-5-full', smea: 'smea' })
    p = naiBodies.at(-1).parameters
    assert.equal(p.sm, false, 'SMEA is not sent to V5')
  })

  await check('DNA with a Chinese description: only its tag line reaches NovelAI', async () => {
    const { saveCharacter, loadCharacters, substituteKeywords, deleteCharacter, promptTags } = await import('../lib/characters.js')
    const dna = '成年女性，银白色长直发。\n外观标签：adult woman, silver hair, black lace blindfold'
    assert.equal(promptTags(dna), 'adult woman, silver hair, black lace blindfold')
    assert.equal(promptTags('仅在参考时采用。黑色手套。black gloves, belt'), 'black gloves, belt')
    assert.equal(promptTags('默认保留眼罩，只有剧情写出时才移除。'), '')
    const { character } = await saveCharacter({ name: '薇尔莉特', keywords: '薇尔莉特', fixedFeatures: dna })
    try {
      const doc = await loadCharacters()
      assert.equal(substituteKeywords(doc, '薇尔莉特, standing').text, 'adult woman, silver hair, black lace blindfold, standing')
    } finally {
      await deleteCharacter(character.id)
    }
  })

  await check('keyword replacement leaves already-expanded DNA alone', async () => {
    const { saveCharacter, loadCharacters, substituteKeywords, deleteCharacter } = await import('../lib/characters.js')
    const { character } = await saveCharacter({ name: '复测角色', keywords: 'miku, Hatsune Miku', fixedFeatures: 'hatsune miku, twintails, aqua hair' })
    try {
      const doc = await loadCharacters()
      // The writer is told to use the DNA, so a row often holds it already.
      assert.equal(substituteKeywords(doc, 'hatsune miku, twintails, aqua hair, sitting').text, 'hatsune miku, twintails, aqua hair, sitting')
      assert.equal(
        substituteKeywords(doc, 'miku waves, hatsune miku, twintails, aqua hair').text,
        'hatsune miku, twintails, aqua hair waves, hatsune miku, twintails, aqua hair'
      )
    } finally {
      await deleteCharacter(character.id)
    }
  })

  // ------------------------------------------------- unreachable NovelAI --
  // A TCP server that accepts and never answers: over https the TLS handshake
  // hangs, which is what a blackholed direct route looks like. Plus a port with
  // nothing listening. Each counts the connections it saw.
  const blackhole = { connections: 0, sockets: new Set() }
  const hang = createNetServer((socket) => {
    blackhole.connections += 1
    blackhole.sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => blackhole.sockets.delete(socket))
    socket.resume()
  })
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve))
  const hangPort = hang.address().port
  const closedServer = createNetServer()
  await new Promise((resolve) => closedServer.listen(0, '127.0.0.1', resolve))
  const closedPort = closedServer.address().port
  await new Promise((resolve) => closedServer.close(resolve))
  const realBase = `http://127.0.0.1:${naiPort}`

  try {
    await call('POST', '/config', { connectTimeoutMs: 2000 })

    await check('a render against a blackholed route fails at the connect deadline with NAI_UNREACHABLE', async () => {
      await call('POST', '/config', { baseUrl: `https://127.0.0.1:${hangPort}` })
      blackhole.connections = 0
      const started = Date.now()
      const response = await call('POST', '/generate', { prompt: 'x' })
      const elapsed = Date.now() - started
      assert.equal(response.status, 400)
      assert.equal(response.json.code, 'NAI_UNREACHABLE')
      assert.match(response.json.error, /连不上 NovelAI（127\.0\.0\.1:\d+）：在限定时间内没有连上/)
      assert.ok(elapsed >= 1900 && elapsed < 4500, `took ${elapsed}ms`)
      // Not retried: one connection, not one per attempt with backoff.
      assert.equal(blackhole.connections, 1)
    })

    await check('jobs queued behind a connect failure fail with it instead of waiting their turn', async () => {
      blackhole.connections = 0
      const started = Date.now()
      // One key → one slot: the first job connects, two wait in the queue.
      const response = await call('POST', '/generate', { prompt: 'x', nSamples: 3 })
      const elapsed = Date.now() - started
      assert.equal(response.status, 400)
      assert.equal(response.json.code, 'NAI_UNREACHABLE')
      assert.ok(elapsed < 4500, `three jobs took ${elapsed}ms (sequential would be ≥ 6000)`)
      assert.equal(blackhole.connections, 1, 'the queued jobs never opened a connection')
      const status = await call('GET', '/status')
      assert.equal(status.json.keySummary.queuedCount, 0)
      assert.equal(status.json.keySummary.activeCount, 0)
    })

    await check('a refused connection fails at once and is not retried', async () => {
      await call('POST', '/config', { baseUrl: `http://127.0.0.1:${closedPort}` })
      const started = Date.now()
      const response = await call('POST', '/generate', { prompt: 'x' })
      assert.equal(response.status, 400)
      assert.equal(response.json.code, 'NAI_UNREACHABLE')
      assert.match(response.json.error, /连接被拒绝/)
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms; a retry with backoff takes seconds`)
      // A connect failure is not the key's fault: it is not cooled down or disabled.
      const keys = (await call('GET', '/keys')).json.keys
      assert.ok(keys.every((key) => key.status !== 'cooldown' && key.enabled), JSON.stringify(keys.map((k) => k.status)))
    })

    await check('a probe on a dead route answers within its deadline', async () => {
      await call('POST', '/config', { baseUrl: `https://127.0.0.1:${hangPort}` })
      const started = Date.now()
      const probed = await call('POST', '/probe')
      const elapsed = Date.now() - started
      assert.equal(probed.status, 200)
      assert.equal(probed.json.ok, false)
      assert.equal(probed.json.code, 'NAI_UNREACHABLE')
      assert.ok(elapsed < 12500, `probe took ${elapsed}ms`)
    })

    await check('a probe answers while a render is stuck; closing the response cancels the render', async () => {
      await call('POST', '/config', { baseUrl: realBase })
      naiHangRenders = true
      naiHeld.length = 0
      let probeResult = null
      let probeMs = 0
      const render = await call('POST', '/generate', { prompt: 'stuck', nSamples: 2 }, {
        beforeEnd: async (res) => {
          while (naiHeld.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
          const status = await call('GET', '/status')
          assert.equal(status.json.keySummary.activeCount, 1)
          assert.equal(status.json.keySummary.queuedCount, 1)
          const started = Date.now()
          probeResult = await call('POST', '/probe')
          probeMs = Date.now() - started
          res.emit('close')
        }
      })
      assert.equal(probeResult.status, 200)
      assert.equal(probeResult.json.ok, true, JSON.stringify(probeResult.json))
      assert.ok(probeMs < 1500, `probe waited ${probeMs}ms behind the render`)
      assert.notEqual(render.status, 200)
      // The upstream request was torn down and nothing is left queued.
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.ok(naiHeld.every((held) => held.closed), 'the NovelAI request was not cancelled')
      assert.equal(naiHeld.length, 1, 'the queued job never started')
      const status = await call('GET', '/status')
      assert.equal(status.json.keySummary.activeCount, 0)
      assert.equal(status.json.keySummary.queuedCount, 0)
      naiHangRenders = false
    })

    await check('blank proxy connects directly; a direct failure points at the base URL; a dead proxy port is named', async () => {
      const nai = await import('../lib/nai.js')
      const net = await import('../lib/net.js')
      // Like nai-dbgen: the base URL (official or a relay) is called directly unless a proxy is set.
      assert.equal(net.resolveProxy('', 'http://127.0.0.1:7897'), null)
      assert.equal(net.resolveProxy('off', 'http://127.0.0.1:7897'), null)
      assert.equal(net.resolveProxy('auto', 'http://127.0.0.1:7897'), 'http://127.0.0.1:7897')
      assert.equal(net.resolveProxy('http://127.0.0.1:7890', null), 'http://127.0.0.1:7890')
      assert.equal(nai.proxyFor({ proxy: '' }), null)
      const direct = nai.proxyHint(null, { code: 'ECONNECT_TIMEOUT' }, { host: 'relay.example' })
      assert.match(direct, /^直连 relay\.example 失败：请检查 设置 → 连接 → 接口域名/)
      const dead = nai.proxyHint('http://127.0.0.1:7897', { code: 'ECONNREFUSED', proxyHop: true }, { system: { enabled: true, server: '127.0.0.1:7897' } })
      assert.match(dead, /代理 127\.0\.0\.1:7897 没有在监听，代理软件可能没开/)
      const info = nai.parseRegProxyInfo('    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n')
      assert.deepEqual(info, { enabled: false, server: '127.0.0.1:7897', url: null })
      const split = nai.parseRegProxyInfo('ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    http=127.0.0.1:1080;https=127.0.0.1:1081\n')
      assert.deepEqual(split, { enabled: true, server: '127.0.0.1:1081', url: 'http://127.0.0.1:1081' })
      assert.equal(nai.parseRegProxy('ProxyEnable    REG_DWORD    0x0\nProxyServer    REG_SZ    127.0.0.1:7897\n'), null)
    })

    await check('/status reports the network route and the recorded system proxy', async () => {
      const status = await call('GET', '/status')
      const network = status.json.network
      assert.equal(typeof network, 'object')
      assert.ok('proxy' in network && 'proxySetting' in network)
      assert.equal(typeof network.system.enabled, 'boolean')
      assert.equal(typeof network.system.server, 'string')
      assert.equal(status.json.connectTimeoutMs, 2000)
    })
  } finally {
    naiHangRenders = false
    for (const held of naiHeld) held.res.destroy()
    for (const socket of blackhole.sockets) socket.destroy()
    hang.close()
    await call('POST', '/config', { baseUrl: realBase, connectTimeoutMs: 12000 })
  }

  // ---------------------------------------------------------- curated models --
  await check('curated ids behave like their family everywhere a model is tested', async () => {
    const models = await import('../lib/models.js')
    const ucPresets = await import('../lib/uc-presets.js')
    const naiLib = await import('../lib/nai.js')
    const ids = models.MODEL_OPTIONS.map((row) => row.id)
    for (const id of [
      'nai-diffusion-5-curated',
      'nai-diffusion-5-full-inpainting',
      'nai-diffusion-4-5-curated',
      'nai-diffusion-4-5-curated-inpainting',
      'nai-diffusion-4-curated-preview',
      'nai-diffusion-4-curated-inpainting'
    ]) {
      assert.ok(ids.includes(id), `${id} is listed`)
    }
    assert.equal(models.modelFamily('nai-diffusion-5-curated'), 'v5')
    assert.equal(models.modelFamily('nai-diffusion-4-5-curated-inpainting'), 'v4.5')
    assert.equal(models.modelFamily('nai-diffusion-4-curated-preview'), 'v4')
    assert.equal(models.modelFamily('nai-diffusion-furry-3'), 'v3')
    assert.equal(ucPresets.ucPresetText('nai-diffusion-5-curated', 1), ucPresets.ucPresetText('nai-diffusion-5-full', 1))
    assert.equal(ucPresets.ucPresetText('nai-diffusion-4-5-curated', 1), ucPresets.ucPresetText('nai-diffusion-4-5-full', 1))
    assert.notEqual(ucPresets.ucPresetText('nai-diffusion-4-5-curated', 1), '')
    assert.equal(naiLib.noiseScheduleFor('nai-diffusion-5-curated', 'native'), 'karras')
    const base = { prompt: 'x', negativePrompt: '', width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', variety: true, transparent: true }
    const v5c = naiLib.buildPayload({ ...base, model: 'nai-diffusion-5-curated' })
    assert.ok(v5c.parameters.v4_prompt, 'V5 Curated gets the structured caption')
    assert.equal(v5c.parameters.straight_alpha, true, 'V5 Curated gets 透明底')
    assert.equal(v5c.parameters.skip_cfg_above_sigma, undefined)
    const v45c = naiLib.buildPayload({ ...base, model: 'nai-diffusion-4-5-curated' })
    assert.ok(v45c.parameters.skip_cfg_above_sigma > 0, 'V4.5 Curated gets variety')
    assert.equal(v45c.parameters.straight_alpha, undefined)
    const v4c = naiLib.buildPayload({ ...base, model: 'nai-diffusion-4-curated-preview' })
    assert.equal(v4c.parameters.params_version, 4)
    const status = await call('GET', '/status')
    assert.deepEqual(status.json.models.find((row) => row.id === 'nai-diffusion-5-curated'), {
      id: 'nai-diffusion-5-curated',
      label: 'NAI Diffusion V5 Curated',
      family: 'v5',
      inpaint: false
    })
  })

  await check('inpainting: V5 Curated maps to V5 Full Inpainting with a note; V4 Curated preview to its own', async () => {
    const models = await import('../lib/models.js')
    assert.equal(models.inpaintingModelFor('nai-diffusion-4-curated-preview').model, 'nai-diffusion-4-curated-inpainting')
    assert.equal(models.inpaintingModelFor('nai-diffusion-4-5-curated').model, 'nai-diffusion-4-5-curated-inpainting')
    assert.equal(models.inpaintingModelFor('nai-diffusion-5-full-inpainting').model, 'nai-diffusion-5-full-inpainting')
    naiBodies.length = 0
    const png = makePng(64, 64).toString('base64')
    const response = await call('POST', '/inpaint', {
      prompt: 'x',
      width: 64,
      height: 64,
      base: `data:image/png;base64,${png}`,
      mask: `data:image/png;base64,${png}`,
      model: 'nai-diffusion-5-curated'
    })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(naiBodies[0].model, 'nai-diffusion-5-full-inpainting')
    assert.match(response.json.notes.join(), /V5 Curated 没有局部重绘模型/)
  })

  // -------------------------------------------------------------- balance --
  await check('balance: Anlas and energy per key, also in /probe and on the key after verify', async () => {
    const naiLib = await import('../lib/nai.js')
    assert.deepEqual(
      naiLib.parseSubscriptionBalance({ tier: 3, trainingStepsLeft: { fixedTrainingStepsLeft: 8000, purchasedTrainingStepsLeft: 5 }, usage: { percent: 0, isNegative: true, timeUntilNextPercent: 0 } }),
      { tier: 3, anlas: { fixed: 8000, purchased: 5, total: 8005 }, energy: { percent: 0, unavailable: true, refillSeconds: 0 } }
    )
    assert.equal(naiLib.parseSubscriptionBalance({ trainingStepsLeft: {} }).energy, null)
    const balance = await call('GET', '/balance')
    assert.equal(balance.status, 200)
    assert.match(balance.json.checkedAt, /^\d{4}-\d\d-\d\dT/)
    assert.equal(balance.json.keys.length, 1)
    const row = balance.json.keys[0]
    assert.deepEqual(
      { ok: row.ok, tier: row.tier, anlas: row.anlas, energy: row.energy },
      { ok: true, tier: 3, anlas: { fixed: 1000, purchased: 250, total: 1250 }, energy: { percent: 80, unavailable: false, refillSeconds: 90 } }
    )
    assert.equal(typeof row.fingerprint, 'string')
    assert.doesNotMatch(JSON.stringify(balance.json), /fake-test-token/)
    const probed = await call('POST', '/probe')
    assert.deepEqual(probed.json.balance.anlas, { fixed: 1000, purchased: 250, total: 1250 })
    const verified = await call('POST', '/keys/verify')
    assert.equal(verified.json.keys[0].subscription.anlas.total, 1250)
    assert.equal(verified.json.keys[0].subscription.energy.percent, 80)
    assert.match(naiLib.formatBalance(verified.json.keys[0].subscription), /^电量 80%（约 2 分钟后 \+1%） · Anlas 1,250（订阅 1,000 · 购买 250）$/)
  })

  // ---------------------------------------------------- character pictures --
  await check('character preview: renders the DNA + variant, keeps it as the cover, survives a save', async () => {
    naiBodies.length = 0
    const saved = await call('POST', '/characters/save', {
      character: {
        groupId,
        name: 'Carol',
        keywords: ['Carol'],
        fixedFeatures: '红发少女\n外观标签：1girl, red hair, green eyes',
        variableFeatures: [{ name: '校服', prompt: 'school uniform, red ribbon' }],
        negative: 'blonde hair'
      }
    })
    const carolId = saved.json.character.id
    assert.equal(saved.json.character.hasCover, false)
    const preview = await call('POST', '/characters/preview', { id: carolId, variant: 0, artistId: -1 })
    assert.equal(preview.status, 200, JSON.stringify(preview.json))
    assert.equal(
      naiBodies[0].input,
      '1girl, red hair, green eyes, school uniform, red ribbon, solo, full body, standing, looking at viewer, simple background, white background'
    )
    assert.match(naiBodies[0].parameters.negative_prompt, /blonde hair/)
    assert.equal(naiBodies[0].parameters.width, 832)
    assert.equal(naiBodies[0].parameters.height, 1216)
    assert.equal(preview.json.character.hasCover, true)
    const version = preview.json.character.coverVersion
    assert.ok(version !== '')
    const image = await call('GET', `/character-image?id=${encodeURIComponent(carolId)}`)
    assert.equal(image.status, 200)
    assert.equal(image.headers['Cache-Control'], 'no-cache')
    assert.ok(image.body.equals(await readFile(preview.json.files[0].file)))
    // A client save that never heard of the cover must not drop it.
    const resaved = await call('POST', '/characters/save', { character: { ...saved.json.character, name: 'Carol 2', coverVersion: '' } })
    assert.equal(resaved.json.character.coverVersion, version)
    assert.equal(resaved.json.character.hasCover, true)
    const listed = await call('GET', '/characters')
    assert.equal(listed.json.characters.find((row) => row.id === carolId).hasCover, true)
    // setCover: false renders without touching the cover.
    const noCover = await call('POST', '/characters/preview', { id: carolId, prompt: 'custom prompt', setCover: false, artistId: -1, width: 1024, height: 1024 })
    assert.equal(noCover.json.character.coverVersion, version)
    assert.equal(naiBodies.at(-1).input, 'custom prompt')
    assert.equal(naiBodies.at(-1).parameters.width, 1024)
    const badVariant = await call('POST', '/characters/preview', { id: carolId, variant: 5 })
    assert.equal(badVariant.status, 400)
  })

  await check('character covers: set from the gallery, traversal refused, delete, removed with the character', async () => {
    const list = await call('GET', '/characters')
    const carol = list.json.characters.find((row) => row.name === 'Carol 2')
    const other = list.json.characters.find((row) => row.name === 'Alice')
    const set = await call('POST', '/characters/cover', { id: other.id, from: galleryName })
    assert.equal(set.status, 200)
    assert.equal(set.json.character.hasCover, true)
    const traversal = await call('POST', '/characters/cover', { id: other.id, from: '..\\nai-imagegen\\config.json' })
    assert.equal(traversal.status, 400)
    const removed = await call('POST', '/characters/cover/delete', { id: other.id })
    assert.equal(removed.json.character.hasCover, false)
    assert.equal(removed.json.character.coverVersion, '')
    assert.equal((await call('GET', `/character-image?id=${encodeURIComponent(other.id)}`)).status, 404)
    await call('POST', '/characters/delete', { id: carol.id })
    const characterCovers = join(stateDir, 'characters', 'covers')
    const { readdir: listDir } = await import('node:fs/promises')
    assert.deepEqual(await listDir(characterCovers), [], 'the deleted character\'s cover went with it')
  })

  // --------------------------------------------------------------- gallery --
  await check('gallery: rows carry size and seed; stats; delete keeps a batch sidecar until its last PNG', async () => {
    const { utimes } = await import('node:fs/promises')
    const stamp = '2030-01-01T00-00-00-000Z'
    const files = [`${stamp}-1.png`, `${stamp}-2.png`]
    for (const [i, name] of files.entries()) {
      await writeFile(join(outputDir, name), makePng(8, 8))
      const t = new Date(Date.UTC(2030, 0, 1, 0, 0, i))
      await utimes(join(outputDir, name), t, t)
    }
    await writeFile(
      join(outputDir, `${stamp}.json`),
      JSON.stringify({ request: { width: 832, height: 1216 }, files: files.map((name, i) => ({ name, seed: 100 + i, size: '832x1216' })) })
    )
    const page = await call('GET', '/gallery?limit=600')
    assert.equal(page.status, 200)
    assert.equal(typeof page.json.total, 'number')
    const row = page.json.files.find((entry) => entry.name === files[1])
    assert.deepEqual({ width: row.width, height: row.height, seed: row.seed }, { width: 832, height: 1216, seed: 101 })
    const stats = await call('GET', '/gallery/stats')
    assert.equal(stats.json.count, page.json.total)
    assert.ok(stats.json.bytes > 0)
    assert.equal(stats.json.outputDir, outputDir)
    assert.equal(typeof stats.json.keepImages, 'number')

    const first = await call('POST', '/gallery/delete', { names: [files[0], 'never-existed.png'] })
    assert.deepEqual(first.json, { ok: true, deleted: 1, missing: ['never-existed.png'] })
    await readFile(join(outputDir, `${stamp}.json`), 'utf8') // still there: -2 remains
    const second = await call('POST', '/gallery/delete', { names: [files[1]] })
    assert.equal(second.json.deleted, 1)
    await assert.rejects(() => readFile(join(outputDir, `${stamp}.json`), 'utf8'), /ENOENT/)
    const traversal = await call('POST', '/gallery/delete', { names: ['../nai-imagegen/config.json'] })
    assert.equal(traversal.status, 400)
    const notPng = await call('POST', '/gallery/delete', { names: ['notes.json'] })
    assert.equal(notPng.status, 400)
    await readFile(join(stateDir, 'config.json'), 'utf8')
  })

  await check('gallery trim: keep 0 empties the gallery, sidecars included; a negative keep is refused', async () => {
    assert.equal((await call('POST', '/gallery/trim', { keep: -1 })).status, 400)
    const before = (await call('GET', '/gallery/stats')).json.count
    assert.ok(before > 0)
    const trimmed = await call('POST', '/gallery/trim', { keep: 0 })
    assert.deepEqual(trimmed.json, { ok: true, deleted: before })
    assert.equal((await call('GET', '/gallery/stats')).json.count, 0)
    const { readdir: listDir } = await import('node:fs/promises')
    assert.deepEqual((await listDir(outputDir)).filter((name) => name.endsWith('.json')), [])
    const status = await call('GET', '/status')
    assert.deepEqual(status.json.newest, [])
  })

  await check('keepImages trims the output directory after a render', async () => {
    const { readdir } = await import('node:fs/promises')
    const before = await call('GET', '/config')
    await call('POST', '/config', { keepImages: 2 })
    try {
      for (let i = 0; i < 3; i += 1) {
        const response = await call('POST', '/generate', { prompt: `trim ${i}` })
        assert.equal(response.status, 200, JSON.stringify(response.json))
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      const pngs = (await readdir(outputDir)).filter((name) => name.endsWith('.png'))
      assert.equal(pngs.length, 2, `kept ${pngs.length}: ${pngs.join(', ')}`)
      const jsons = (await readdir(outputDir)).filter((name) => name.endsWith('.json'))
      assert.ok(jsons.length <= 2, 'sidecars of trimmed renders are gone too')
    } finally {
      await call('POST', '/config', { keepImages: before.json.keepImages ?? 500 })
    }
  })

  // ------------------------------------------------- refusals and the log --
  const logLib = await import('../lib/log.js')
  const GOOGLE_REFUSAL =
    "The prompt could not be submitted. The prompt contains sensitive words that violate Google's [Generative AI " +
    'Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy). Try rephrasing the prompt. If ' +
    'you think this was an error, [send feedback](https://ai.google.dev/gemini-api/docs/troubleshooting).'

  await check('detectRefusal: provider refusals yes, captions and chatter no', () => {
    const google = writer.detectRefusal(GOOGLE_REFUSAL)
    assert.equal(google.refused, true)
    assert.match(google.reason, /^The prompt could not be submitted\. .*Prohibited Use policy\./)
    assert.doesNotMatch(google.reason, /https?:/)
    assert.equal(writer.detectRefusal('抱歉，我无法生成这类内容。').refused, true)
    assert.equal(writer.detectRefusal("I'm sorry, but I can't help with that.").refused, true)
    assert.equal(writer.detectRefusal('Your request was blocked by the safety filter.').refused, true)
    assert.equal(writer.detectRefusal('I would draw a park.'), null)
    assert.equal(writer.detectRefusal(''), null)
    // A caption that merely mentions a policy is a caption.
    assert.equal(writer.parseWriterReply('scene: office, policy document on desk\nscene_uc: lowres').ok, true)
  })

  await check('POST /write: a provider refusal stops after one attempt with WRITER_REFUSED, names the DNA, is logged', async () => {
    await logLib.clearLog()
    llmCalls.length = 0
    services.llm = fakeLlm([GOOGLE_REFUSAL])
    const response = await call('POST', '/write', { naturalLanguage: '爱丽丝在酒馆里喝酒' })
    assert.equal(response.status, 422)
    assert.equal(response.json.code, 'WRITER_REFUSED')
    assert.equal(response.json.refusal, true)
    assert.equal(response.json.attempts, 1)
    assert.equal(llmCalls.length, 1, 'no corrective retry for a refusal')
    assert.deepEqual(response.json.characters, ['Alice'])
    assert.match(response.json.error, /^模型（not\/claude-opus-5-5）拒绝了这次请求，原因是它的内容审核，不是格式问题：The prompt could not be submitted\./)
    assert.match(response.json.error, /这次请求里带了这些角色的 DNA：Alice。可以换一个模型（设置 → 提示词模型）/)
    assert.match(response.json.logId, /^[a-z0-9]{8}$/)
    const logs = await call('GET', '/logs?event=write')
    const entry = logs.json.entries.find((row) => row.id === response.json.logId)
    assert.ok(entry, 'the write entry exists')
    assert.equal(entry.outcome, 'refused')
    assert.equal(entry.level, 'warn')
    assert.deepEqual(entry.characters, ['Alice'])
    assert.deepEqual(entry.route, { provider: 'not', model: 'claude-opus-5-5' })
    assert.equal(entry.attempts.length, 1)
    assert.match(entry.attempts[0].replyHead, /could not be submitted/)
    assert.equal(entry.attempts[0].finishKind, 'stop')
    assert.ok(entry.attempts[0].usage)
    assert.match(entry.userPrompt, /【Alice】/)
    assert.ok(entry.systemChars > 0 && entry.userChars === entry.userPrompt.length)
    assert.equal(typeof entry.summary, 'string')
    const warn = await call('GET', '/logs?level=warn')
    assert.ok(warn.json.entries.some((row) => row.id === response.json.logId))
  })

  await check('POST /write: garbage twice then a caption is three logged attempts and outcome ok', async () => {
    services.llm = fakeLlm(['blah blah', 'still no fields here', 'scene: tavern, night\nscene_uc: lowres'])
    const response = await call('POST', '/write', { naturalLanguage: 'a tavern' })
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json.attempts, 3)
    const entry = (await call('GET', '/logs?event=write')).json.entries.find((row) => row.id === response.json.logId)
    assert.equal(entry.outcome, 'ok')
    assert.equal(entry.attempts.length, 3)
    assert.deepEqual(entry.attempts.map((row) => row.n), [1, 2, 3])
    assert.ok(entry.attempts[0].issues.length > 0)
    assert.deepEqual(entry.attempts[2].issues, [])
    assert.equal(typeof entry.attempts[1].ms, 'number')
    assert.equal(typeof entry.ms, 'number')
  })

  await check('the format error keeps its shape and gains logId + characters', async () => {
    services.llm = fakeLlm(['no fields at all'])
    await call('POST', '/config', { writerRetries: 0 })
    const response = await call('POST', '/write', { naturalLanguage: 'Alice waves' })
    await call('POST', '/config', { writerRetries: 2 })
    assert.equal(response.status, 422)
    assert.equal(response.json.code, 'WORKBENCH_CAPTION_INVALID')
    assert.deepEqual(response.json.characters, ['Alice'])
    const entry = (await call('GET', '/logs?event=write')).json.entries.find((row) => row.id === response.json.logId)
    assert.equal(entry.outcome, 'invalid')
  })

  await check('POST /characters/from-image: a refusal stops at once with WRITER_REFUSED', async () => {
    llmCalls.length = 0
    services.llm = fakeLlm([GOOGLE_REFUSAL])
    const image = `data:image/png;base64,${makePng(4, 4).toString('base64')}`
    const response = await call('POST', '/characters/from-image', { image })
    assert.equal(response.status, 422)
    assert.equal(response.json.code, 'WRITER_REFUSED')
    assert.equal(llmCalls.length, 1)
    assert.doesNotMatch(response.json.error, /DNA：/)
    const entry = (await call('GET', '/logs?event=dna')).json.entries.find((row) => row.id === response.json.logId)
    assert.equal(entry.outcome, 'refused')
    assert.equal(entry.image, true)
    assert.doesNotMatch(JSON.stringify(entry), /base64,/)
  })

  await check('the empty /write is logged too, and its 400 carries the logId', async () => {
    const response = await call('POST', '/write', { naturalLanguage: '' })
    assert.equal(response.status, 400)
    assert.match(response.json.logId, /^[a-z0-9]{8}$/)
  })

  await check('redaction: no token, no Bearer value, no data URL, long strings cut', async () => {
    const png = makePng(16, 16).toString('base64')
    const id = logLib.logEvent('test', {
      summary: 'redaction',
      token: 'pst-test-token',
      note: 'header was Authorization: Bearer xyz.secret-value and key pst-abcDEF_987-xyz',
      nested: { apiKey: 'sk-live-123', list: ['pst-anotherOne999'] },
      picture: `data:image/png;base64,${png}`,
      buffer: Buffer.from('raw bytes'),
      long: 'x'.repeat(13000)
    })
    await logLib.flushLog()
    const text = await readFile(join(stateDir, 'logs', `${logLib.localDay()}.jsonl`), 'utf8')
    const line = text.split('\n').find((row) => row.includes(`"id":"${id}"`))
    assert.ok(line, 'the entry was written')
    for (const secret of ['pst-test-token', 'xyz.secret-value', 'pst-abcDEF_987-xyz', 'sk-live-123', 'pst-anotherOne999', png.slice(0, 40), 'base64,']) {
      assert.ok(!line.includes(secret), `${secret} leaked`)
    }
    const entry = JSON.parse(line)
    assert.equal(entry.token, '<redacted>')
    assert.equal(entry.nested.apiKey, '<redacted>')
    assert.match(entry.note, /Bearer <redacted>/)
    assert.match(entry.picture, /^<image: \d+ bytes, image\/png>$/)
    assert.equal(entry.buffer, '<binary: 9 bytes>')
    assert.ok(entry.long.length < 12100 && /已截断，原长 13000 字符/.test(entry.long))
    assert.equal(entry.level, 'info')
  })

  await check('renders are logged: success with files, NAI_UNREACHABLE with logId on the error body', async () => {
    naiBodies.length = 0
    const ok = await call('POST', '/generate', { prompt: 'a cat, sitting', seed: 4242, artistOverride: null })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    const okEntry = (await call('GET', '/logs?event=render')).json.entries.find((row) => row.id === ok.json.logId)
    assert.equal(okEntry.outcome, 'ok')
    assert.equal(okEntry.kind, 'generate')
    assert.deepEqual(okEntry.files, [ok.json.files[0].name])
    assert.equal(okEntry.seed, 4242)
    assert.equal(typeof okEntry.width, 'number')
    assert.match(okEntry.promptHead, /a cat, sitting/)
    assert.equal(typeof okEntry.ms, 'number')
    assert.doesNotMatch(JSON.stringify(okEntry), /fake-test-token/)

    await call('POST', '/config', { baseUrl: `http://127.0.0.1:${closedPort}` })
    const failed = await call('POST', '/generate', { prompt: 'x' })
    await call('POST', '/config', { baseUrl: realBase })
    assert.equal(failed.status, 400)
    assert.equal(failed.json.code, 'NAI_UNREACHABLE')
    assert.match(failed.json.logId, /^[a-z0-9]{8}$/)
    const failEntry = (await call('GET', '/logs?event=render&level=error')).json.entries.find((row) => row.id === failed.json.logId)
    assert.equal(failEntry.outcome, 'error')
    assert.equal(failEntry.code, 'NAI_UNREACHABLE')
    assert.equal(failEntry.networkCode, 'ECONNREFUSED')
    assert.match(failEntry.error, /连不上 NovelAI/)
    assert.equal(typeof failEntry.model, 'string')
  })

  await check('probe, balance and handler errors are logged', async () => {
    const probed = await call('POST', '/probe')
    const probeEntry = (await call('GET', '/logs?event=probe')).json.entries.find((row) => row.id === probed.json.logId)
    assert.equal(probeEntry.ok, true)
    await call('GET', '/balance')
    assert.ok((await call('GET', '/logs?event=balance')).json.entries.length >= 1)
    const broken = await call('GET', '/file-meta?name=..%2Fx.png')
    assert.equal(broken.status, 400)
    const errorEntry = (await call('GET', '/logs?event=error')).json.entries.find((row) => row.id === broken.json.logId)
    assert.equal(errorEntry.route, 'GET /file-meta')
    assert.match(errorEntry.stack, /Error/)
  })

  await check('/logs, /logs/download, /logs/clear; old files are pruned', async () => {
    const status = await call('GET', '/status')
    assert.equal(status.json.logDir, join(stateDir, 'logs'))
    const listing = await call('GET', '/logs?limit=3')
    assert.equal(listing.json.entries.length, 3)
    assert.equal(listing.json.dir, join(stateDir, 'logs'))
    const today = logLib.localDay()
    const todayRow = listing.json.days.find((row) => row.day === today)
    assert.ok(todayRow.count > 3 && todayRow.bytes > 0)
    // Newest first.
    assert.ok(listing.json.entries[0].at >= listing.json.entries[2].at)
    const download = await call('GET', `/logs/download?day=${today}`)
    assert.equal(download.status, 200)
    assert.equal(download.headers['Content-Disposition'], `attachment; filename="nai-imagegen-${today}.jsonl"`)
    const lines = download.body.toString('utf8').trim().split('\n')
    assert.equal(lines.length, todayRow.count)
    assert.ok(lines.every((line) => JSON.parse(line).id))
    assert.equal((await call('GET', '/logs/download?day=2001-01-01')).status, 404)
    assert.equal((await call('GET', '/logs/download?day=../../x')).status, 400)

    const cleared = await call('POST', '/logs/clear')
    assert.equal(cleared.json.ok, true)
    assert.ok(cleared.json.removed >= 1)
    assert.deepEqual((await call('GET', '/logs')).json.entries, [])
    // Pruning runs on the first write of a day: a 20-day-old file goes, a 13-day-old one stays.
    const dayAgo = (n) => logLib.localDay(new Date(Date.now() - n * 86400000))
    await mkdir(join(stateDir, 'logs'), { recursive: true })
    await writeFile(join(stateDir, 'logs', `${dayAgo(20)}.jsonl`), '{"id":"old"}\n')
    await writeFile(join(stateDir, 'logs', `${dayAgo(13)}.jsonl`), '{"id":"kept"}\n')
    logLib.logEvent('test', { summary: 'first write after clear' })
    await logLib.flushLog()
    const days = (await call('GET', '/logs')).json.days.map((row) => row.day)
    assert.ok(!days.includes(dayAgo(20)), 'the 20-day-old file was pruned')
    assert.ok(days.includes(dayAgo(13)), 'the 13-day-old file was kept')
    assert.ok(days.includes(today))
  })

  await check('nothing was written outside the temp DSH_HOME', async () => {
    const config = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'))
    assert.equal(config.outputDir, outputDir)
    assert.ok(stateDir.startsWith(tmpdir()))
  })
} finally {
  nai.closeAllConnections()
  nai.close()
  await rm(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${passed} passed, ${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\n${passed} passed`)
}
