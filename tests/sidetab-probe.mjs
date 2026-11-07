// Offline probe for the right-sidebar workbench: loads client.js against a stub
// host and a stub React, checks the two-stage tab registration, then renders the
// panel's sidebar layout with seeded state and walks the tree.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'client.js'), 'utf8')

const status = {
  model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral',
  tokenSet: false, tokenSource: 'none', maxImagesPerCall: 4, header: '', qualityToggle: false, negativePrompt: 'lowres',
  codeButtons: false, autoGenerate: false, artistId: -1, artistCount: 0, sourceDir: 'C:/in', outputDir: 'C:/out',
  keySummary: { keyCount: 1, usableKeyCount: 0, concurrency: 1, keyIssues: [] },
  keys: [{ id: 'k1', label: 'main', fingerprint: 'pst-…abcd', enabled: true, status: 'unverified', completed: 0 }],
  libraries: [{ library: '同人库8.5', entries: 2 }],
  newest: [{ name: 'a.png' }, { name: 'b.png' }]
}
const form = { ...status, baseUrl: 'https://image.novelai.net', proxy: '', ucPreset: 3, outputDir: 'C:/out', sourceDir: '', libraryDir: 'C:/idx', librarySourceDir: 'C:/src', keepImages: 500, token: '' }
const libResult = { total: 1, hits: [{ library: '同人库8.5', uid: 0, title: '初音未来', keys: 'miku', content: '- 初音未来:hatsune miku, twintails' }] }
const doctor = { ok: false, checks: [{ name: 'a check', ok: false, detail: 'why' }, { name: 'b check', ok: true }] }

// Stub React. `useState(null)` slots are seeded in call order; the sidebar keeps
// every pane mounted, so one render reaches all four.
let seeds = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => {
    if (initial === null && seeds.length > 0) return [seeds.shift(), () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value ?? null }),
  useMemo: (fn) => fn()
}

let factory = null
globalThis.window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' })
// The sidebar restores its workbench draft from localStorage.
const draftStore = new Map([['nai-imagegen:workbench-draft', JSON.stringify({
  nlText: '雨后天台', baseNeg: 'lowres',
  charRows: [{ name: 'A', positive: 'girl, aqua hair', negative: '', center: { x: 0.3, y: 0.5 } }, { name: '', positive: 'boy', negative: '', center: null }]
})]])
globalThis.localStorage = { getItem: (k) => draftStore.get(k) ?? null, setItem: (k, v) => draftStore.set(k, v) }
new Function(source)()
assert.equal(typeof factory, 'function', 'client.js should register a module factory')
const mod = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require ${name}`)
})

// ---- registration -----------------------------------------------------------
const injected = {}
const slotRegs = []
const tabRegs = []
const ctx = {
  effect: () => {},
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: {
    inject: (name, cb) => { injected[name] = cb },
    register: (spec, component) => { slotRegs.push({ spec, component }); return () => {} }
  },
  get: (name) => (name === 'sidebarRightTabs' ? { register: (def) => { tabRegs.push(def); return () => {} } } : null)
}
mod.apply(ctx)
assert.ok(injected['sidebar.right.pane.tab'], 'the right-pane seat should be injected')
assert.ok(injected['sidebar.panellist'], 'the left panellist row should still be injected')
const dispose = injected['sidebar.right.pane.tab']()
assert.equal(typeof dispose, 'function', 'the seat callback should return a disposer')
assert.equal(tabRegs.length, 1)
const def = tabRegs[0]
assert.equal(def.id, 'dsh-nai-imagegen/quick')
assert.equal(def.kind, 'nai-imagegen')
assert.equal(def.keepMounted, true)
assert.equal(def.guide[0].title(), 'sideGuideTitle')
assert.equal(def.guide[0].icon({ size: 16 }).type, mod.PanelIcon)
const body = slotRegs.find((r) => r.spec.name === 'sidebar.right.pane.tab')
assert.ok(body, 'the tab body should be registered on the keyed seat')
assert.equal(body.spec.key, def.id, 'the body key must equal the type id')

// The body renders the panel in its sidebar layout.
const bodyEl = body.component()
assert.equal(bodyEl.type, mod.NaiPanel)
assert.equal(bodyEl.props.layout, 'side')

// ---- sidebar render ---------------------------------------------------------
const walk = (tree) => {
  const elements = []
  const texts = []
  const visit = (node) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node !== 'object') { texts.push(String(node)); return }
    elements.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return { elements, texts }
}
const render = (seed) => {
  // status, form, probed, baseline, libInfo, libResult, doctor, styleDetail
  seeds = [...seed]
  const tree = mod.NaiPanel({ t: (key) => key, layout: 'side' })
  seeds = []
  return walk(tree)
}

const clean = render([status, form, null, { ...form }, null, libResult, doctor, null])
const has = (r, text) => r.texts.some((s) => s.includes(text))
const byClass = (r, name) => r.elements.filter((n) => String(n.props.className ?? '').split(' ').includes(name))

assert.equal(byClass(clean, 'nai-s').length, 1, 'one sidebar root')
assert.equal(byClass(clean, 'nai-s-tab').length, 5, 'five tabs')
for (const key of ['sideNavCreate', 'sideNavEdit', 'sideNavGallery', 'sideNavLibrary', 'sideNavSettings']) assert.ok(has(clean, key), key)
assert.equal(byClass(clean, 'nai-s-pane').length, 5, 'all five panes stay mounted')
assert.equal(byClass(clean, 'nai-s-pane').filter((n) => !n.props.hidden).length, 1, 'only one pane is visible')
assert.ok(clean.elements.some((n) => n.type === 'canvas'), 'the inpaint canvases are mounted')
assert.ok(has(clean, 'sideNoTokenPill'), 'a missing credential is surfaced on the create tab')
assert.ok(has(clean, 'sideFree'), 'the free-band pill is shown')
assert.ok(has(clean, '初音未来'), 'library hits render')
assert.ok(has(clean, 'sideInsertTag'), 'a roster hit offers to insert its tag')
assert.ok(has(clean, 'a check') && has(clean, 'why'), 'health-check failures render with their detail')
assert.equal(byClass(clean, 'nai-s-savebar').length, 0, 'no save bar while the form matches the baseline')
assert.equal(byClass(clean, 'nai-s-keyrow').length, 1, 'one key row')
// The gallery list is its own `useState([])`, which this stub does not seed.
assert.ok(has(clean, 'sideGalleryEmpty'), 'an empty gallery says how to start')
assert.ok(clean.elements.some((n) => n.type === 'datalist' && n.props.id === 'nai-s-samplers'), 'sampler suggestions')
// The artist-string bar sits on the create tab and on the edit tab.
assert.equal(byClass(clean, 'nai-s-stylebar').length, 2, 'a style bar on create and on edit')
assert.ok(has(clean, 'sideStyleNone') && has(clean, 'sideStyleChoose'), 'no style selected says so and offers a pick')

// With a style in force the bar names it and shows its tags.
// ---- workbench ----
const charDoc = {
  groups: [{ id: 'g1', name: '默认分组', active: true }],
  characters: [{ id: 'c1', groupId: 'g1', name: '初音未来', keywords: ['miku'], fixedFeatures: 'hatsune miku, twintails', variableFeatures: [{ name: '校服', prompt: 'school uniform' }], negative: '' }]
}
// useState(null) slots after styleDetail: refImage, lastSeed, lastWrite, llmInfo, llmModelList, presetData,
// presetDraft, charDoc — so charDoc is the 14th seeded null.
const wb = render([status, form, null, { ...form }, null, null, null, null, null, null, null,
  { available: true, provider: 'not', model: 'claude', vision: true, source: 'dsh-default' }, null, null, null, charDoc])
assert.ok(byClass(wb, 'nai-s-write').length === 1, 'the writer box')
assert.ok(has(wb, 'sideWriteTitle') && has(wb, 'sideWrite'), 'the writer has its title and button')
assert.equal(byClass(wb, 'nai-s-row-card').length, 2, 'two caption rows restored from the draft')
assert.equal(byClass(wb, 'nai-s-grid5').length, 2, 'each row has a position grid')
assert.equal(byClass(wb, 'nai-s-grid5')[0].children.length, 25, 'the grid has 25 cells')
assert.ok(has(wb, 'A1') || wb.elements.some((n) => n.props?.title === 'A1'), 'cells are labelled')
assert.ok(has(wb, 'sideMarket') && has(wb, 'sideLlm') && has(wb, 'sidePresets'), 'market, model and preset cards')
assert.ok(has(wb, 'sideReplaceKw'), 'keyword replacement toggle')
assert.ok(has(wb, '初音未来') && has(wb, 'hatsune miku, twintails'), 'the character library lists the character and its DNA')
assert.ok(has(wb, '＋校服'), 'a variable feature can be added as a row')
assert.ok(has(wb, 'sideDnaFromImage'), 'DNA from image is offered')
assert.ok(wb.elements.some((n) => n.type === 'optgroup' && n.props.label === '默认分组'), 'characters can be added to the caption from a picker')
assert.ok(has(wb, 'not/claude'), 'the writer names the model it uses')
// batch 3: model picker with curated models, balance card, character keyword picker, gallery management
const modelSelects = wb.elements.filter((n) => n.type === 'select' && n.elements === undefined && (n.children ?? []).some?.((c) => c?.type === 'optgroup'))
assert.ok(wb.elements.some((n) => n.type === 'option' && n.props.value === 'nai-diffusion-5-curated'), 'V5 Curated is offered')
assert.ok(wb.elements.some((n) => n.type === 'option' && n.props.value === 'nai-diffusion-4-5-curated'), 'V4.5 Curated is offered')
assert.ok(!wb.elements.some((n) => n.type === 'option' && /-inpainting$/.test(String(n.props.value))), 'inpainting models are not text-to-image choices')
assert.ok(wb.elements.some((n) => n.type === 'option' && n.props.value === '__custom'), 'a custom model id is still possible')
assert.ok(has(wb, 'sideBalance') && has(wb, 'sideBalanceHint'), 'the balance block says what it reads')
assert.ok(wb.elements.some((n) => n.type === 'select' && n.props['aria-label'] === 'sideInsertChar'), 'a character keyword can be added to the description')
assert.ok(has(wb, 'sideGalleryManage') && has(wb, 'sideTrimKeep') && has(wb, 'sideDeleteAll'), 'the gallery tab can trim and delete')
assert.ok(has(wb, 'sideCharRefGen'), 'a character card can render its reference image')
// debug log: a card in 设置 with filters, download and clear
assert.ok(has(wb, 'sideLog') && has(wb, 'sideLogHint'), 'the log card says what it records')
// an empty reference library is hidden; its index card moves to 设置 with a note
const noBooks = render([{ ...status, libraries: [{ library: '同人库8.5', entries: 0 }] }, form, null, { ...form }, null, null, doctor, null])
const exact = (r, text) => r.texts.some((s) => s === text)
assert.ok(!exact(noBooks, 'sideBooks'), 'no 参考库 segment while nothing is indexed')
assert.ok(!exact(noBooks, 'sidePickRefs'), 'no 挑参考条目 button while nothing is indexed')
assert.ok(has(noBooks, 'sideBooksEmptyHint') && has(noBooks, 'sideReindex'), 'the empty library explains itself in 设置 and can be rebuilt')
assert.ok(exact(clean, 'sideBooks') && exact(clean, 'sidePickRefs'), 'an indexed library keeps its segment and button')
assert.ok(has(wb, 'sideLogErrorsOnly') && has(wb, 'sideLogDownload') && has(wb, 'sideLogClear'), 'the log can be filtered, downloaded and cleared')

const styled = render([
  { ...status, artistId: 4, artistCount: 210, artistGroups: [{ group: 'a', count: 200 }, { group: 'b', count: 10 }],
    modeSettings: [{ mode: 'illustration', artistId: 4, artistName: '古风', overrides: {} }, { mode: 'comic', artistId: 4, overrides: {} }] },
  form, null, { ...form }, null, null, null,
  { id: 4, name: '古风', positivePrompt: 'artist:abc, 1.2::ink::', thumb: { start: 0, length: 1 } }
])
assert.ok(has(styled, '古风'), 'the selected style is named')
assert.ok(has(styled, 'artist:abc, 1.2::ink::'), 'its tags are shown')
assert.ok(has(styled, 'sideStyleRemove') && has(styled, 'sideStyleChange'), 'clear and change are offered')
assert.ok(styled.elements.some((n) => n.type === 'img' && String(n.props.src).includes('artist-image?id=4&thumb=1')), 'the bar uses the thumbnail')

const dirty = render([status, { ...form, steps: 30 }, null, { ...form }, null, null, null, null])
assert.equal(byClass(dirty, 'nai-s-savebar').length, 1, 'an edited field shows the save bar')

const page = (() => {
  seeds = [status, form, null, { ...form }]
  const tree = mod.NaiPanel({ t: (key) => key })
  seeds = []
  return walk(tree)
})()
assert.equal(byClass(page, 'nai-s').length, 0, 'the left-panel page keeps its own layout')

dispose()
console.log('sidetab probe: all checks passed')
