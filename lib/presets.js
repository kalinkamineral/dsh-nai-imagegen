/**
 * dsh-nai-imagegen — named prompt presets (write / dna).
 *
 * The shape follows the DSH preset-plus plugin: a document with one active id
 * per kind plus a map of presets, so the panel can list them, switch between
 * them, and edit a copy without touching the shipped text.
 *
 *   {
 *     "version": 2,
 *     "kinds": {
 *       "write": { "activeId": "builtin-write", "items": { "custom-…": { … } } },
 *       "dna":   { … }
 *     }
 *   }
 *
 * Built-ins are never stored: their text always comes from the package, so a
 * later improvement of the shipped prompt reaches every user who did not copy
 * it. A custom item stores its own full `system` / `user` text.
 *
 * Version 1 (`{ write: { system?, user? }, dna: { … } }`, the single-preset
 * override file) is migrated on first load into one 「我的预设（迁移）」 item per
 * kind that had overrides, and that item becomes active.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_DIR } from './config.js'

/** Where the preset document lives. */
export const PRESETS_FILE = join(STATE_DIR, 'presets.json')
/** The two prompt families. */
export const PRESET_KINDS = ['write', 'dna']

const VERSION = 2
const BUILTIN_NAME = { write: '内置 · 单图生图', dna: '内置 · 角色 DNA' }
const BUILTIN_DESCRIPTION = {
  write: '随插件更新，只读；编辑时自动另存为自定义预设',
  dna: '随插件更新，只读；编辑时自动另存为自定义预设'
}
const MAX_TEXT = 200000

/** Cached document; invalidated on every save. */
let cache = null

/** @returns the id of the shipped preset for one kind. */
export function builtinPresetId(kind) {
  return `builtin-${kind}`
}

/**
 * The shipped preset for one kind, as a list entry.
 * @param kind - `write` or `dna`.
 * @param builtins - `{ write: {system,user}, dna: {system,user} }`.
 * @returns the entry (never stored on disk).
 */
export function builtinPreset(kind, builtins) {
  return {
    id: builtinPresetId(kind),
    kind,
    name: BUILTIN_NAME[kind],
    description: BUILTIN_DESCRIPTION[kind],
    system: String(builtins[kind]?.system ?? ''),
    user: String(builtins[kind]?.user ?? ''),
    builtin: true
  }
}

/** @returns a fresh empty document. */
function emptyDoc() {
  const kinds = {}
  for (const kind of PRESET_KINDS) kinds[kind] = { activeId: builtinPresetId(kind), items: {} }
  return { version: VERSION, kinds }
}

/** @returns a safe string, capped. */
function text(value, fallback = '') {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : fallback
}

/** @returns a safe id fragment. */
function safeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60)
}

/**
 * Sanitise a document read from disk.
 * @param raw - parsed JSON.
 * @param builtins - the shipped presets.
 * @returns a valid document.
 */
function normalizeDoc(raw, builtins) {
  const doc = emptyDoc()
  const kinds = raw?.kinds
  if (kinds === null || typeof kinds !== 'object') return doc
  for (const kind of PRESET_KINDS) {
    const state = kinds[kind]
    if (state === null || typeof state !== 'object') continue
    const items = state.items
    if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
      for (const [key, row] of Object.entries(items)) {
        if (row === null || typeof row !== 'object') continue
        const id = safeId(row.id ?? key)
        if (id === '' || id.startsWith('builtin-')) continue
        doc.kinds[kind].items[id] = {
          id,
          name: text(row.name).trim().slice(0, 80) || '未命名预设',
          description: text(row.description).trim().slice(0, 200),
          system: text(row.system, builtins[kind].system),
          user: text(row.user, builtins[kind].user)
        }
      }
    }
    const activeId = safeId(state.activeId)
    if (activeId === builtinPresetId(kind) || doc.kinds[kind].items[activeId] !== undefined) {
      doc.kinds[kind].activeId = activeId
    }
  }
  return doc
}

/**
 * Migrate the version-1 single-override file.
 * @param raw - unpacked JSON.
 * @param builtins - the shipped presets.
 * @returns the migrated document.
 */
function migrateDoc(raw, builtins) {
  const doc = emptyDoc()
  for (const kind of PRESET_KINDS) {
    const overrides = raw?.[kind]
    if (overrides === null || typeof overrides !== 'object') continue
    const system = typeof overrides.system === 'string' ? overrides.system : builtins[kind].system
    const user = typeof overrides.user === 'string' ? overrides.user : builtins[kind].user
    if (system === builtins[kind].system && user === builtins[kind].user) continue
    const id = `custom-${kind}-migrated`
    doc.kinds[kind].items[id] = { id, name: '我的预设（迁移）', description: '从旧版单预设迁移', system, user }
    doc.kinds[kind].activeId = id
  }
  return doc
}

/**
 * Read (and cache) the document.
 * @param builtins - the shipped presets.
 * @param options - `{ reload?: boolean }`.
 * @returns the document.
 */
export async function loadDoc(builtins, options = {}) {
  if (cache !== null && options.reload !== true) return cache
  let raw = null
  try {
    raw = JSON.parse(await readFile(PRESETS_FILE, 'utf8'))
  } catch {
    raw = null
  }
  const doc =
    raw === null
      ? emptyDoc()
      : raw?.version === VERSION
        ? normalizeDoc(raw, builtins)
        : migrateDoc(raw, builtins)
  cache = doc
  return doc
}

/**
 * Write the document through a temp file.
 * @param doc - the document.
 * @returns the document.
 */
export async function saveDoc(doc) {
  const next = { ...doc, version: VERSION }
  await mkdir(dirname(PRESETS_FILE), { recursive: true })
  const temp = `${PRESETS_FILE}.tmp`
  await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(temp, PRESETS_FILE)
  cache = next
  return next
}

/**
 * Resolve one kind for the panel: builtin first, then customs.
 * @param kind - `write` or `dna`.
 * @param doc - the document.
 * @param builtins - the shipped presets.
 * @returns `{ activeId, items }`.
 */
function kindView(kind, doc, builtins) {
  const state = doc.kinds[kind]
  const items = [builtinPreset(kind, builtins)]
  for (const row of Object.values(state.items)) {
    items.push({
      id: row.id,
      kind,
      name: row.name,
      description: row.description,
      system: row.system,
      user: row.user,
      builtin: false
    })
  }
  return { activeId: state.activeId, items }
}

/**
 * The list the panel edits: every preset with its full text.
 * @param builtins - the shipped presets.
 * @returns `{ version, kinds: { write: {activeId, items}, dna: … } }`.
 */
export async function listPresets(builtins) {
  const doc = await loadDoc(builtins)
  const kinds = {}
  for (const kind of PRESET_KINDS) kinds[kind] = kindView(kind, doc, builtins)
  return { version: VERSION, kinds }
}

/**
 * The text actually used by the writer.
 * @param builtins - the shipped presets.
 * @returns `{ write: {system,user}, dna: {system,user} }`.
 */
export async function resolveActivePresets(builtins) {
  const doc = await loadDoc(builtins)
  const out = {}
  for (const kind of PRESET_KINDS) {
    const view = kindView(kind, doc, builtins)
    const active = view.items.find((row) => row.id === doc.kinds[kind].activeId) ?? view.items[0]
    out[kind] = { system: active.system, user: active.user }
  }
  return out
}

/**
 * Switch the active preset of one kind.
 * @param kind - `write` or `dna`.
 * @param id - a builtin or custom id.
 * @param builtins - the shipped presets.
 * @returns the refreshed list.
 */
export async function selectPreset(kind, id, builtins) {
  if (!PRESET_KINDS.includes(kind)) throw new Error(`未知的预设类型：${kind}`)
  const doc = await loadDoc(builtins, { reload: true })
  const wanted = safeId(id)
  if (wanted !== builtinPresetId(kind) && doc.kinds[kind].items[wanted] === undefined) {
    throw Object.assign(new Error('没有这个预设'), { status: 404 })
  }
  doc.kinds[kind].activeId = wanted
  await saveDoc(doc)
  return listPresets(builtins)
}

/**
 * Create or update a custom preset and make it active.
 *
 * Saving over a builtin is not allowed; the panel sends the edited text and this
 * creates a custom copy named after the form instead, so the shipped text stays
 * intact.
 *
 * @param input - `{ kind, id?, name?, description?, system?, user? }`.
 * @param builtins - the shipped presets.
 * @returns `{ list, item }`.
 */
export async function savePreset(input, builtins) {
  const kind = String(input?.kind ?? '')
  if (!PRESET_KINDS.includes(kind)) throw new Error(`未知的预设类型：${kind}`)
  const doc = await loadDoc(builtins, { reload: true })
  const state = doc.kinds[kind]
  const requestedId = safeId(input?.id)
  const isBuiltin = requestedId === builtinPresetId(kind) || requestedId === ''
  let id = requestedId
  if (isBuiltin) id = `custom-${kind}-${Date.now().toString(36)}`
  if (!isBuiltin && state.items[id] === undefined) id = `custom-${kind}-${Date.now().toString(36)}`
  const previous = state.items[id] ?? {}
  const builtin = builtinPreset(kind, builtins)
  const name = text(input?.name).trim().slice(0, 80) || previous.name || '未命名预设'
  const row = {
    id,
    name,
    description: text(input?.description, previous.description ?? '').trim().slice(0, 200),
    system: text(input?.system, previous.system ?? builtin.system),
    user: text(input?.user, previous.user ?? builtin.user)
  }
  state.items[id] = row
  state.activeId = id
  await saveDoc(doc)
  const list = await listPresets(builtins)
  return { list, item: { ...row, kind, builtin: false } }
}

/**
 * Copy one preset (builtin or custom) into a new custom preset.
 * @param input - `{ kind, fromId, name? }`.
 * @param builtins - the shipped presets.
 * @returns `{ list, item }`.
 */
export async function duplicatePreset(input, builtins) {
  const kind = String(input?.kind ?? '')
  if (!PRESET_KINDS.includes(kind)) throw new Error(`未知的预设类型：${kind}`)
  const list = await listPresets(builtins)
  const source = list.kinds[kind].items.find((row) => row.id === safeId(input?.fromId))
  if (source === undefined) throw Object.assign(new Error('没有这个预设'), { status: 404 })
  return savePreset(
    {
      kind,
      name: text(input?.name).trim().slice(0, 80) || `${source.name} 副本`,
      description: source.description,
      system: source.system,
      user: source.user
    },
    builtins
  )
}

/**
 * Delete a custom preset; the builtin cannot be deleted.
 * @param input - `{ kind, id }`.
 * @param builtins - the shipped presets.
 * @returns the refreshed list.
 */
export async function deletePreset(input, builtins) {
  const kind = String(input?.kind ?? '')
  if (!PRESET_KINDS.includes(kind)) throw new Error(`未知的预设类型：${kind}`)
  const doc = await loadDoc(builtins, { reload: true })
  const id = safeId(input?.id)
  if (id === builtinPresetId(kind)) throw Object.assign(new Error('内置预设不能删除'), { status: 400 })
  delete doc.kinds[kind].items[id]
  if (doc.kinds[kind].activeId === id) doc.kinds[kind].activeId = builtinPresetId(kind)
  await saveDoc(doc)
  return listPresets(builtins)
}

/**
 * Make the shipped preset active again.
 * @param kind - `write` or `dna`.
 * @param builtins - the shipped presets.
 * @returns the refreshed list.
 */
export async function resetPresetKind(kind, builtins) {
  if (!PRESET_KINDS.includes(kind)) throw new Error(`未知的预设类型：${kind}`)
  const doc = await loadDoc(builtins, { reload: true })
  doc.kinds[kind].activeId = builtinPresetId(kind)
  await saveDoc(doc)
  return listPresets(builtins)
}

/**
 * Replace the whole document from an imported JSON (panel import).
 * @param raw - parsed JSON in either the v2 or the v1 shape.
 * @param builtins - the shipped presets.
 * @returns the refreshed list.
 */
export async function importPresets(raw, builtins) {
  if (raw === null || typeof raw !== 'object') throw Object.assign(new Error('导入内容不是 JSON 对象'), { status: 400 })
  const doc = raw.version === VERSION ? normalizeDoc(raw, builtins) : migrateDoc(raw, builtins)
  await saveDoc(doc)
  return listPresets(builtins)
}

/**
 * The document as the panel exports it.
 * @param builtins - the shipped presets.
 * @returns a JSON-serializable document.
 */
export async function exportPresets(builtins) {
  const doc = await loadDoc(builtins)
  return { version: VERSION, kinds: doc.kinds }
}
