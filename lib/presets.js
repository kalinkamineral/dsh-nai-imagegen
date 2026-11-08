/**
 * dsh-nai-imagegen — named prompt presets built from message segments.
 *
 * Shape follows the DSH preset-plus editor: one active preset per kind, and a
 * preset is an ordered list of segments. A segment carries
 *
 *   { id, name, role: 'system' | 'user' | 'assistant',
 *     enabled: boolean, content: string }
 *
 * so the user can mix system instructions, user messages and assistant turns in
 * any order and disable one without deleting it.
 *
 *   {
 *     "version": 3,
 *     "kinds": {
 *       "write": { "activeId": "builtin-write", "items": { "custom-…": { …segments… } } },
 *       "dna":   { … }
 *     }
 *   }
 *
 * Older files are migrated on read: a version-2 item's `system`/`user` strings
 * become two segments, and the version-1 override file becomes one migrated
 * custom preset per kind.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_DIR } from './config.js'

/** Where the preset document lives. */
export const PRESETS_FILE = join(STATE_DIR, 'presets.json')
/** The two prompt families. */
export const PRESET_KINDS = ['write', 'dna']
/** Roles a segment may carry. */
export const PRESET_ROLES = ['system', 'user', 'assistant']

const VERSION = 3
const MAX_CONTENT = 200000
const MAX_SEGMENTS = 60
const BUILTIN_NAME = { write: '内置 · 单图生图', dna: '内置 · 角色 DNA' }
const BUILTIN_DESCRIPTION = {
  write: '随插件更新，只读；编辑后保存会自动另存为自定义预设',
  dna: '随插件更新，只读；编辑后保存会自动另存为自定义预设'
}

/** Cached document and the file mtime it was read at; invalidated on every save. */
let cache = null
let cacheStamp = null

/** @returns the file mtime in ms, or null when the file does not exist. */
async function fileStamp() {
  try {
    return (await stat(PRESETS_FILE)).mtimeMs
  } catch {
    return null
  }
}

/** @returns the id of the shipped preset for one kind. */
export function builtinPresetId(kind) {
  return `builtin-${kind}`
}

/** @returns a new segment id. */
function newSegmentId() {
  return `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** @returns a safe string, capped. */
function text(value, fallback = '') {
  return typeof value === 'string' ? value.slice(0, MAX_CONTENT) : fallback
}

/** @returns a safe id fragment. */
function safeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60)
}

/**
 * Sanitise one segment.
 * @param raw - the segment as stored.
 * @param fallbackName - name when the row has none.
 * @returns a segment, or null.
 */
function normalizeSegment(raw, fallbackName = '段') {
  if (raw === null || typeof raw !== 'object') return null
  const role = PRESET_ROLES.includes(raw.role) ? raw.role : 'user'
  // An empty segment is allowed while a brand-new preset is being written; the
  // writer skips empty segments when composing messages.
  const content = typeof raw.content === 'string' ? raw.content.slice(0, MAX_CONTENT) : ''
  return {
    id: safeId(raw.id) || newSegmentId(),
    name: text(raw.name).trim().slice(0, 60) || fallbackName,
    role,
    enabled: raw.enabled !== false,
    content
  }
}

/** @returns a deep copy of the shipped segments. */
function clonedBuiltin(builtin) {
  return (builtin?.segments ?? []).map((segment) => ({ ...segment, id: safeId(segment.id) || newSegmentId() }))
}

/**
 * Turn a stored item into segments, migrating the older `system`/`user` shape.
 * @param row - one preset item.
 * @param builtin - the shipped segments for that kind.
 * @returns the segment list.
 */
function itemSegments(row, builtin) {
  if (Array.isArray(row?.segments)) {
    const segments = []
    for (const [index, raw] of row.segments.entries()) {
      const segment = normalizeSegment(raw, `段 ${index + 1}`)
      if (segment !== null) segments.push(segment)
    }
    if (segments.length > 0) return segments
  }
  // Version 2: {system, user} strings. The version-1 migration uses this path too.
  if (typeof row?.system === 'string' || typeof row?.user === 'string') {
    const segments = []
    if (typeof row.system === 'string' && row.system.trim() !== '') {
      segments.push({ id: 'seg-system', name: '系统提示', role: 'system', enabled: true, content: row.system })
    }
    if (typeof row.user === 'string' && row.user.trim() !== '') {
      segments.push({ id: 'seg-user', name: '用户消息', role: 'user', enabled: true, content: row.user })
    }
    if (segments.length > 0) return segments
  }
  return clonedBuiltin(builtin)
}

/**
 * The shipped preset as a list entry.
 * @param kind - `write` or `dna`.
 * @param builtins - shipped segments per kind.
 * @returns the entry (never stored on disk).
 */
export function builtinPreset(kind, builtins) {
  return {
    id: builtinPresetId(kind),
    kind,
    name: BUILTIN_NAME[kind],
    description: BUILTIN_DESCRIPTION[kind],
    segments: clonedBuiltin(builtins[kind]),
    builtin: true
  }
}

/** @returns a fresh empty document. */
function emptyDoc() {
  const kinds = {}
  for (const kind of PRESET_KINDS) kinds[kind] = { activeId: builtinPresetId(kind), items: {} }
  return { version: VERSION, kinds }
}

/**
 * Sanitise a document read from disk.
 * @param raw - parsed JSON.
 * @param builtins - shipped segments per kind.
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
        const segments = itemSegments(row, builtins[kind]).slice(0, MAX_SEGMENTS)
        if (segments.length === 0) continue
        doc.kinds[kind].items[id] = {
          id,
          name: text(row.name).trim().slice(0, 80) || '未命名预设',
          description: text(row.description).trim().slice(0, 200),
          segments
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
 * @param builtins - shipped segments per kind.
 * @returns the migrated document.
 */
function migrateDoc(raw, builtins) {
  const doc = emptyDoc()
  for (const kind of PRESET_KINDS) {
    const overrides = raw?.[kind]
    if (overrides === null || typeof overrides !== 'object') continue
    const system = typeof overrides.system === 'string' ? overrides.system : ''
    const user = typeof overrides.user === 'string' ? overrides.user : ''
    if (system.trim() === '' && user.trim() === '') continue
    const id = `custom-${kind}-migrated`
    doc.kinds[kind].items[id] = {
      id,
      name: '我的预设（迁移）',
      description: '从旧版单预设迁移',
      segments: itemSegments({ system, user }, builtins[kind])
    }
    doc.kinds[kind].activeId = id
  }
  return doc
}

/**
 * Read (and cache) the document.
 * @param builtins - shipped segments per kind.
 * @param options - `{ reload?: boolean }`.
 * @returns the document.
 */
export async function loadDoc(builtins, options = {}) {
  const stamp = await fileStamp()
  // A hand-edited presets.json must take effect without restarting DSH: reload
  // whenever the file's mtime moved since the cached read.
  if (cache !== null && options.reload !== true && stamp === cacheStamp) return cache
  let raw = null
  try {
    raw = JSON.parse(await readFile(PRESETS_FILE, 'utf8'))
  } catch {
    raw = null
  }
  const doc =
    raw === null
      ? emptyDoc()
      : raw?.kinds
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
  await writeFile(temp, JSON.stringify(next, null, 2) + String.fromCharCode(10), 'utf8')
  await rename(temp, PRESETS_FILE)
  cache = next
  cacheStamp = await fileStamp()
  return next
}

/**
 * Resolve one kind for the panel: builtin first, then customs.
 * @param kind - `write` or `dna`.
 * @param doc - the document.
 * @param builtins - shipped segments per kind.
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
      segments: row.segments.map((segment) => ({ ...segment })),
      builtin: false
    })
  }
  return { activeId: state.activeId, items }
}

/**
 * The list the panel edits: every preset with its segments.
 * @param builtins - shipped segments per kind.
 * @returns `{ version, kinds: { write: {activeId, items}, dna: … } }`.
 */
export async function listPresets(builtins) {
  const doc = await loadDoc(builtins)
  const kinds = {}
  for (const kind of PRESET_KINDS) kinds[kind] = kindView(kind, doc, builtins)
  return { version: VERSION, kinds }
}

/**
 * The active preset of each kind.
 * @param builtins - shipped segments per kind.
 * @returns `{ write: {segments}, dna: {segments} }`.
 */
export async function resolveActivePresets(builtins) {
  const doc = await loadDoc(builtins)
  const out = {}
  for (const kind of PRESET_KINDS) {
    const view = kindView(kind, doc, builtins)
    const active = view.items.find((row) => row.id === doc.kinds[kind].activeId) ?? view.items[0]
    out[kind] = {
      id: active.id,
      name: active.name,
      builtin: active.builtin === true,
      segments: active.segments.map((segment) => ({ ...segment }))
    }
  }
  return out
}

/**
 * Switch the active preset of one kind.
 * @param kind - `write` or `dna`.
 * @param id - a builtin or custom id.
 * @param builtins - shipped segments per kind.
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
 * Sanitise a segment list coming from the panel.
 * @param segments - raw array.
 * @param builtin - fallback text source.
 * @returns at least one segment.
 */
function cleanSegments(segments, builtin) {
  const out = []
  if (Array.isArray(segments)) {
    for (const [index, raw] of segments.entries()) {
      const segment = normalizeSegment(raw, `段 ${index + 1}`)
      if (segment !== null) out.push(segment)
      if (out.length >= MAX_SEGMENTS) break
    }
  }
  return out.length > 0 ? out : clonedBuiltin(builtin)
}

/**
 * Create or update a custom preset and make it active.
 *
 * Saving over a builtin creates a custom copy, so the shipped text stays intact.
 *
 * @param input - `{ kind, id?, name?, description?, segments }`.
 * @param builtins - shipped segments per kind.
 * @returns `{ list, item }`.
 */
export async function savePreset(input, builtins) {
  const kind = String(input?.kind ?? '')
  if (!PRESET_KINDS.includes(kind)) throw new Error(`未知的预设类型：${kind}`)
  const doc = await loadDoc(builtins, { reload: true })
  const state = doc.kinds[kind]
  const builtin = builtins[kind]
  const requestedId = safeId(input?.id)
  const isBuiltin = requestedId === builtinPresetId(kind) || requestedId === ''
  let id = requestedId
  if (isBuiltin) id = `custom-${kind}-${Date.now().toString(36)}`
  if (!isBuiltin && state.items[id] === undefined) id = `custom-${kind}-${Date.now().toString(36)}`
  const previous = state.items[id] ?? {}
  const row = {
    id,
    name: text(input?.name).trim().slice(0, 80) || previous.name || '未命名预设',
    description: text(input?.description, previous.description ?? '').trim().slice(0, 200),
    segments: cleanSegments(input?.segments ?? previous.segments, builtin)
  }
  state.items[id] = row
  state.activeId = id
  await saveDoc(doc)
  const list = await listPresets(builtins)
  return { list, item: { ...row, kind, builtin: false } }
}

/**
 * Create a brand-new, empty custom preset and make it active.
 *
 * The new preset holds one empty segment so the editor has a row to type into;
 * the writer ignores empty segments when composing messages.
 *
 * @param input - `{ kind, name? }`.
 * @param builtins - shipped segments per kind.
 * @returns `{ list, item }`.
 */
export async function createPreset(input, builtins) {
  const kind = String(input?.kind ?? '')
  if (!PRESET_KINDS.includes(kind)) throw new Error(`未知的预设类型：${kind}`)
  const doc = await loadDoc(builtins, { reload: true })
  const id = `custom-${kind}-${Date.now().toString(36)}`
  const row = {
    id,
    name: text(input?.name).trim().slice(0, 80) || '新建预设',
    description: '',
    segments: [
      { id: newSegmentId(), name: '段 1', role: 'system', enabled: true, content: '' }
    ]
  }
  doc.kinds[kind].items[id] = row
  doc.kinds[kind].activeId = id
  await saveDoc(doc)
  const list = await listPresets(builtins)
  return { list, item: { ...row, kind, builtin: false } }
}

/**
 * Copy one preset (builtin or custom) into a new custom preset.
 * @param input - `{ kind, fromId, name? }`.
 * @param builtins - shipped segments per kind.
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
      segments: source.segments
    },
    builtins
  )
}

/**
 * Delete a custom preset; the builtin cannot be deleted.
 * @param input - `{ kind, id }`.
 * @param builtins - shipped segments per kind.
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
 * @param builtins - shipped segments per kind.
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
 * Replace the whole document from an imported JSON.
 * @param raw - parsed JSON in the current or an older shape.
 * @param builtins - shipped segments per kind.
 * @returns the refreshed list.
 */
export async function importPresets(raw, builtins) {
  if (raw === null || typeof raw !== 'object') throw Object.assign(new Error('导入内容不是 JSON 对象'), { status: 400 })
  const doc = raw?.kinds ? normalizeDoc(raw, builtins) : migrateDoc(raw, builtins)
  await saveDoc(doc)
  return listPresets(builtins)
}

/**
 * The document as the panel exports it.
 * @param builtins - shipped segments per kind.
 * @returns a JSON-serializable document.
 */
export async function exportPresets(builtins) {
  const doc = await loadDoc(builtins)
  return { version: VERSION, kinds: doc.kinds }
}

/** @returns a new segment id, for the panel's 「添加段」. */
export function nextSegmentId() {
  return newSegmentId()
}
