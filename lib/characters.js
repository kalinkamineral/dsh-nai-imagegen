/**
 * dsh-nai-imagegen — character DNA.
 *
 * A character is a reusable description: a name, the keywords that refer to it
 * in a prompt, its fixed features (the "DNA": hair, eyes, build, marks — what
 * never changes between pictures) and any number of named variable features
 * (outfits, alternate looks). Characters sit in groups; a group can be switched
 * off as a whole.
 *
 * The shape follows nai-dbgen's character model so its exports import as-is:
 *   group     { id, name, active, order }
 *   character { id, groupId, name, keywords[], fixedFeatures, variableFeatures[{ name, prompt }],
 *               negative, matchOverrides { caseSensitive?, matchWholeWords? } | null }
 * `negative` is an addition here: per-character undesired tags, sent as that
 * character's own negative caption.
 *
 * Stored as one JSON document under the plugin's state directory, written via a
 * temp file and a rename like the configuration.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_DIR } from './config.js'

/** The character document. */
export const CHARACTERS_FILE = join(STATE_DIR, 'characters.json')
/** Schema version written into exports; nai-dbgen uses 1 as well. */
export const CHARACTER_SCHEMA_VERSION = 1

/** Cached document; `null` until the first read. */
let cache = null

/** @returns an ISO timestamp. */
const now = () => new Date().toISOString()

/**
 * Split a keyword string on commas, keeping `/regex/flags` whole (a comma
 * inside a regex is part of it).
 * @param text - `a, b, /c,d/i`.
 * @returns the keywords.
 */
export function splitKeywords(text) {
  const out = []
  let buf = ''
  let inRegex = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (!inRegex && ch === '/' && buf.trim() === '') {
      inRegex = true
      buf += ch
      continue
    }
    if (inRegex && ch === '/' && text[i - 1] !== '\\') {
      buf += ch
      let j = i + 1
      while (j < text.length && /[a-z]/i.test(text[j])) {
        buf += text[j]
        j += 1
      }
      i = j - 1
      inRegex = false
      continue
    }
    if (!inRegex && (ch === ',' || ch === '，')) {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/**
 * @param raw - an array or a comma-separated string.
 * @returns trimmed, non-empty keywords.
 */
function normalizeKeywords(raw) {
  if (Array.isArray(raw)) return raw.map((k) => String(k).trim()).filter((k) => k !== '')
  if (typeof raw === 'string') return splitKeywords(raw)
  return []
}

/**
 * @param raw - untrusted variable features.
 * @returns `[{ name, prompt }]`.
 */
function normalizeVariable(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((row) => row !== null && typeof row === 'object')
    .map((row) => ({ name: String(row.name ?? '').trim(), prompt: String(row.prompt ?? '').trim() }))
    .filter((row) => row.name !== '' || row.prompt !== '')
}

/**
 * @param raw - untrusted overrides.
 * @returns the overrides, or `null` when none are set.
 */
function normalizeOverrides(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const out = {}
  if (typeof raw.caseSensitive === 'boolean') out.caseSensitive = raw.caseSensitive
  if (typeof raw.matchWholeWords === 'boolean') out.matchWholeWords = raw.matchWholeWords
  return Object.keys(out).length > 0 ? out : null
}

/**
 * @param raw - an untrusted group.
 * @param fallbackOrder - order when none is given.
 * @returns a group.
 */
function normalizeGroup(raw, fallbackOrder = 0) {
  return {
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    id: String(raw?.id || randomUUID()),
    name: String(raw?.name ?? '').trim() || '未命名分组',
    active: raw?.active !== false,
    order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : fallbackOrder,
    createdAt: String(raw?.createdAt || now()),
    updatedAt: String(raw?.updatedAt || now())
  }
}

/**
 * @param raw - an untrusted character.
 * @param groupId - the group to fall back to.
 * @returns a character.
 */
function normalizeCharacter(raw, groupId) {
  return {
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    id: String(raw?.id || randomUUID()),
    groupId: String(raw?.groupId || groupId),
    name: String(raw?.name ?? '').trim() || '未命名角色',
    keywords: normalizeKeywords(raw?.keywords),
    fixedFeatures: String(raw?.fixedFeatures ?? '').trim(),
    variableFeatures: normalizeVariable(raw?.variableFeatures),
    negative: String(raw?.negative ?? '').trim(),
    matchOverrides: normalizeOverrides(raw?.matchOverrides),
    // When the reference picture (cover) last changed; '' = none. Owned by the
    // host: the cover routes set it, a client save cannot (see saveCharacter).
    coverVersion: typeof raw?.coverVersion === 'string' ? raw.coverVersion : '',
    createdAt: String(raw?.createdAt || now()),
    updatedAt: String(raw?.updatedAt || now())
  }
}

/**
 * Make a document consistent: every character in an existing group, ordered.
 * @param raw - the parsed document.
 * @returns `{ groups, characters }`.
 */
function normalizeDocument(raw) {
  const groups = (Array.isArray(raw?.groups) ? raw.groups : []).map((row, index) => normalizeGroup(row, index))
  if (groups.length === 0) groups.push(normalizeGroup({ name: '默认分组' }, 0))
  const known = new Set(groups.map((row) => row.id))
  const characters = (Array.isArray(raw?.characters) ? raw.characters : []).map((row) => {
    const character = normalizeCharacter(row, groups[0].id)
    if (!known.has(character.groupId)) character.groupId = groups[0].id
    return character
  })
  groups.sort((a, b) => a.order - b.order)
  return { groups, characters }
}

/** @returns the character document. */
export async function loadCharacters() {
  if (cache !== null) return cache
  try {
    cache = normalizeDocument(JSON.parse(await readFile(CHARACTERS_FILE, 'utf8')))
  } catch {
    cache = normalizeDocument({})
  }
  return cache
}

/**
 * Persist the whole document.
 * @param doc - `{ groups, characters }`.
 * @returns the stored document.
 */
async function store(doc) {
  const next = normalizeDocument(doc)
  cache = next
  await mkdir(dirname(CHARACTERS_FILE), { recursive: true })
  const temp = `${CHARACTERS_FILE}.tmp`
  await writeFile(temp, `${JSON.stringify({ schemaVersion: CHARACTER_SCHEMA_VERSION, ...next }, null, 2)}\n`, 'utf8')
  await rename(temp, CHARACTERS_FILE)
  return next
}

/**
 * Create or replace one group.
 * @param input - the group; a missing id creates one.
 * @returns the document.
 */
export async function saveGroup(input) {
  const doc = await loadCharacters()
  const existing = doc.groups.find((row) => row.id === input?.id)
  const group = normalizeGroup({ ...existing, ...input, updatedAt: now() }, doc.groups.length)
  const groups = existing ? doc.groups.map((row) => (row.id === group.id ? group : row)) : [...doc.groups, group]
  return store({ ...doc, groups })
}

/**
 * Delete a group and every character in it. The last group cannot go.
 * @param id - the group id.
 * @returns the document.
 */
export async function deleteGroup(id) {
  const doc = await loadCharacters()
  if (doc.groups.length <= 1) throw new Error('至少要保留一个分组')
  const gone = doc.characters.filter((row) => row.groupId === id)
  const next = await store({
    groups: doc.groups.filter((row) => row.id !== id),
    characters: doc.characters.filter((row) => row.groupId !== id)
  })
  // The group's characters take their reference pictures with them.
  for (const row of gone) await rm(characterCoverFile(row.id), { force: true })
  return next
}

/**
 * Create or replace one character.
 * @param input - the character; a missing id creates one.
 * @returns `{ doc, character }`.
 */
export async function saveCharacter(input) {
  const doc = await loadCharacters()
  const existing = doc.characters.find((row) => row.id === input?.id)
  // `coverVersion` always comes from the stored record: an editor that loaded the
  // character before a preview render would otherwise save the old (or no) value.
  const character = normalizeCharacter(
    { ...existing, ...input, coverVersion: existing?.coverVersion ?? '', updatedAt: now() },
    doc.groups[0].id
  )
  const characters = existing ? doc.characters.map((row) => (row.id === character.id ? character : row)) : [...doc.characters, character]
  const next = await store({ ...doc, characters })
  return { doc: next, character: next.characters.find((row) => row.id === character.id) }
}

/**
 * @param id - the character id.
 * @returns the document.
 */
export async function deleteCharacter(id) {
  const doc = await loadCharacters()
  const next = await store({ ...doc, characters: doc.characters.filter((row) => row.id !== id) })
  await rm(characterCoverFile(id), { force: true })
  return next
}

// ------------------------------------------------------------------ covers --

/** Where character reference pictures are kept. */
export const CHARACTER_COVERS_DIR = join(STATE_DIR, 'characters', 'covers')
/** The PNG signature, checked before a file is accepted as a cover. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The cover file of one character. Ids normally are UUIDs, but an imported file
 * may carry any string, so an id that is not a plain name is hashed rather than
 * used as a path.
 * @param id - the character id.
 * @returns the absolute path (which may not exist).
 */
export function characterCoverFile(id) {
  const raw = String(id ?? '')
  const name = /^[A-Za-z0-9_-]{1,100}$/.test(raw) ? raw : `h-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`
  return join(CHARACTER_COVERS_DIR, `${name}.png`)
}

/**
 * A document with each character's `hasCover`, for the panel. The stored
 * document is not changed.
 * @param doc - the character document.
 * @returns `{ groups, characters }` with `hasCover` on every character.
 */
export async function withCoverFlags(doc) {
  let names = new Set()
  try {
    names = new Set(await readdir(CHARACTER_COVERS_DIR))
  } catch {
    names = new Set()
  }
  return {
    groups: doc.groups,
    characters: doc.characters.map((row) => {
      const file = characterCoverFile(row.id)
      return { ...row, hasCover: names.has(file.slice(CHARACTER_COVERS_DIR.length + 1)) }
    })
  }
}

/**
 * Use a PNG as a character's reference picture.
 * @param id - the character id.
 * @param pngPath - an already validated absolute path of a PNG.
 * @returns `{ doc, character }` (the document as stored; flags are added by the caller).
 */
export async function setCharacterCover(id, pngPath) {
  const doc = await loadCharacters()
  const existing = doc.characters.find((row) => row.id === id)
  if (existing === undefined) throw Object.assign(new Error('角色不存在'), { status: 404 })
  const bytes = await readFile(pngPath)
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw Object.assign(new Error('参考图必须是图库里的 PNG 图片'), { status: 400 })
  }
  await mkdir(CHARACTER_COVERS_DIR, { recursive: true })
  const target = characterCoverFile(id)
  await writeFile(`${target}.tmp`, bytes)
  await rename(`${target}.tmp`, target)
  const next = await store({
    ...doc,
    characters: doc.characters.map((row) => (row.id === id ? { ...row, coverVersion: now() } : row))
  })
  return { doc: next, character: next.characters.find((row) => row.id === id) }
}

/**
 * Remove a character's reference picture.
 * @param id - the character id.
 * @returns `{ doc, character }`.
 */
export async function deleteCharacterCover(id) {
  const doc = await loadCharacters()
  if (!doc.characters.some((row) => row.id === id)) throw Object.assign(new Error('角色不存在'), { status: 404 })
  await rm(characterCoverFile(id), { force: true })
  const next = await store({
    ...doc,
    characters: doc.characters.map((row) => (row.id === id ? { ...row, coverVersion: '' } : row))
  })
  return { doc: next, character: next.characters.find((row) => row.id === id) }
}

/**
 * Export everything, or one group.
 * @param groupId - optional group to restrict to.
 * @returns a self-describing JSON object.
 */
export async function exportCharacters(groupId) {
  const doc = await loadCharacters()
  const groups = groupId ? doc.groups.filter((row) => row.id === groupId) : doc.groups
  const ids = new Set(groups.map((row) => row.id))
  return {
    // nai-dbgen's own envelope kind, so an export from here imports there too;
    // `importCharacters` still accepts the older `nai-imagegen.characters`.
    kind: 'character',
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    exportedAt: now(),
    groups,
    characters: doc.characters.filter((row) => ids.has(row.groupId))
  }
}

/** Name suffix for a duplicate imported under the `rename` strategy (nai-dbgen's). */
export const IMPORT_COPY_SUFFIX = ' · 导入副本'
/** Envelope kinds accepted on import. */
const IMPORT_KINDS = ['character', 'nai-imagegen.characters']
/** Duplicate strategies on import. */
export const DUPLICATE_STRATEGIES = ['overwrite', 'skip', 'rename']

/**
 * Import characters. Accepts this plugin's export, nai-dbgen's envelope
 * (`{ schemaVersion: 1, kind: 'character', groups, characters }`), a bare
 * `characters` array, or a single character.
 *
 * A duplicate is an incoming group or character whose id already exists.
 * `onDuplicate` decides what happens to it:
 *   - `overwrite` (default): replace it, keeping the stored `createdAt`, so
 *     re-importing the same file updates in place instead of duplicating;
 *   - `skip`: keep the stored one;
 *   - `rename`: add a copy with a new id and the suffix ` · 导入副本`. The
 *     characters of a renamed group follow it to the copy.
 *
 * @param payload - the parsed JSON.
 * @param options - `{ groupId?, onDuplicate? }`; `groupId` puts every imported
 *   character into that one group.
 * @returns `{ doc, groups, characters, imported, skipped, renamed }`.
 */
export async function importCharacters(payload, options = {}) {
  const doc = await loadCharacters()
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  if (data !== null && typeof data === 'object' && !Array.isArray(data) && data.kind !== undefined && !IMPORT_KINDS.includes(data.kind)) {
    throw new Error(`这不是角色库文件（kind 是 ${String(data.kind)}，应为 character）`)
  }
  const strategy = DUPLICATE_STRATEGIES.includes(options.onDuplicate) ? options.onDuplicate : 'overwrite'
  const incomingGroups = Array.isArray(data?.groups) ? data.groups : []
  const incomingCharacters = Array.isArray(data?.characters)
    ? data.characters
    : Array.isArray(data)
      ? data
      : data && typeof data === 'object' && 'fixedFeatures' in data
        ? [data]
        : []
  if (incomingCharacters.length === 0 && incomingGroups.length === 0) throw new Error('文件里没有角色')
  const counts = { imported: 0, skipped: 0, renamed: 0 }
  const groups = [...doc.groups]
  // Incoming group id → the id its characters should land in (differs only for
  // a renamed copy).
  const groupMap = new Map()
  for (const raw of incomingGroups) {
    const group = normalizeGroup(raw, groups.length)
    const at = groups.findIndex((row) => row.id === group.id)
    if (at < 0) {
      groups.push(group)
      groupMap.set(group.id, group.id)
    } else if (strategy === 'skip') {
      groupMap.set(group.id, group.id)
    } else if (strategy === 'rename') {
      const copy = { ...group, id: randomUUID(), name: `${group.name}${IMPORT_COPY_SUFFIX}`, order: groups.length, createdAt: now(), updatedAt: now() }
      groups.push(copy)
      groupMap.set(group.id, copy.id)
    } else {
      groups[at] = { ...group, createdAt: groups[at].createdAt, updatedAt: now() }
      groupMap.set(group.id, group.id)
    }
  }
  const target = options.groupId && groups.some((row) => row.id === options.groupId) ? options.groupId : null
  const known = new Set(groups.map((row) => row.id))
  const characters = [...doc.characters]
  for (const raw of incomingCharacters) {
    // A cover is a local file; an imported record cannot bring one along.
    const character = { ...normalizeCharacter(raw, target ?? groups[0].id), coverVersion: '' }
    if (target) character.groupId = target
    else if (groupMap.has(character.groupId)) character.groupId = groupMap.get(character.groupId)
    if (!known.has(character.groupId)) character.groupId = groups[0].id
    const at = characters.findIndex((row) => row.id === character.id)
    if (at < 0) {
      characters.push(character)
      counts.imported += 1
    } else if (strategy === 'skip') {
      counts.skipped += 1
    } else if (strategy === 'rename') {
      characters.push({ ...character, id: randomUUID(), name: `${character.name}${IMPORT_COPY_SUFFIX}`, createdAt: now(), updatedAt: now() })
      counts.imported += 1
      counts.renamed += 1
    } else {
      characters[at] = { ...character, createdAt: characters[at].createdAt, coverVersion: characters[at].coverVersion, updatedAt: now() }
      counts.imported += 1
    }
  }
  const next = await store({ groups, characters })
  return { doc: next, groups: incomingGroups.length, characters: incomingCharacters.length, ...counts }
}

/**
 * The characters of active groups.
 * @param doc - the document.
 * @returns active characters.
 */
export function activeCharacters(doc) {
  const active = new Set(doc.groups.filter((row) => row.active).map((row) => row.id))
  return doc.characters.filter((row) => active.has(row.groupId))
}

/**
 * Build a matcher for one keyword.
 * @param keyword - plain text or `/regex/flags`.
 * @param overrides - the character's match overrides.
 * @returns a global RegExp, or `null` for an unusable keyword.
 */
function keywordPattern(keyword, overrides) {
  const regex = /^\/(.+)\/([a-z]*)$/i.exec(keyword)
  try {
    if (regex) {
      const flags = new Set(regex[2].replace(/g/g, ''))
      flags.add('g')
      return new RegExp(regex[1], [...flags].join(''))
    }
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Whole-word only makes sense for ASCII words; CJK has no word boundaries.
    const whole = overrides?.matchWholeWords === true && /^[\w\s-]+$/.test(keyword)
    return new RegExp(whole ? `\\b${escaped}\\b` : escaped, overrides?.caseSensitive === true ? 'g' : 'gi')
  } catch {
    return null
  }
}

/**
 * Which active characters a text mentions.
 * @param doc - the document.
 * @param text - the text to scan.
 * @returns matched characters, in the order of their first mention.
 */
export function matchCharacters(doc, text) {
  const hits = []
  for (const character of activeCharacters(doc)) {
    let first = Infinity
    for (const keyword of character.keywords) {
      const pattern = keywordPattern(keyword, character.matchOverrides)
      if (pattern === null) continue
      const match = pattern.exec(String(text ?? ''))
      if (match !== null && match.index < first) first = match.index
    }
    if (first !== Infinity) hits.push({ character, at: first })
  }
  return hits.sort((a, b) => a.at - b.at).map((row) => row.character)
}

/**
 * Replace every character keyword in a prompt with that character's fixed
 * features ("替换角色关键词"). Longer keywords first, so `Miku` does not eat
 * part of `Hatsune Miku`.
 * @param doc - the document.
 * @param text - the prompt.
 * @returns `{ text, replaced: [names] }`.
 */
export function substituteKeywords(doc, text) {
  const source = String(text ?? '')
  // Matches are collected on the original text and applied in one pass. Applying
  // keyword by keyword would let a short keyword (`miku`) match again inside the
  // features just inserted for a longer one (`Hatsune Miku` → `hatsune miku, …`).
  const spans = []
  // Text that already is a character's DNA must not be expanded again. The prompt
  // writer is told to use the DNA, so a row often reads `hatsune miku, twintails, …`
  // already, and the keyword `miku` inside it would otherwise double every tag.
  const protectedRanges = []
  for (const character of activeCharacters(doc)) {
    for (const dna of new Set([character.fixedFeatures, promptTags(character.fixedFeatures)])) {
      if (dna === '') continue
      for (let at = source.indexOf(dna); at >= 0; at = source.indexOf(dna, at + dna.length)) {
        protectedRanges.push([at, at + dna.length])
      }
    }
  }
  const isProtected = (start, end) => protectedRanges.some(([from, to]) => start >= from && end <= to)
  for (const character of activeCharacters(doc)) {
    if (character.fixedFeatures === '') continue
    for (const keyword of character.keywords) {
      const pattern = keywordPattern(keyword, character.matchOverrides)
      if (pattern === null) continue
      for (const match of source.matchAll(pattern)) {
        if (match[0] === '') continue
        if (isProtected(match.index, match.index + match[0].length)) continue
        spans.push({ start: match.index, end: match.index + match[0].length, character })
      }
    }
  }
  // Earliest first; at the same start the longest wins; overlaps are dropped.
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let cursor = 0
  const replaced = []
  for (const span of spans) {
    if (span.start < cursor) continue
    // Only the tags go into a NovelAI prompt; a description-only DNA falls back to itself.
    out += source.slice(cursor, span.start) + (promptTags(span.character.fixedFeatures) || span.character.fixedFeatures)
    cursor = span.end
    if (!replaced.includes(span.character.name)) replaced.push(span.character.name)
  }
  out += source.slice(cursor)
  return { text: out, replaced }
}

/**
 * The NovelAI tags inside a DNA or feature text.
 *
 * DNA written for the prompt writer often mixes a Chinese description with an
 * English tag line (`外观标签：adult woman, silver hair, …`). The writer reads the
 * whole text; NovelAI should only get the tags. A labelled tag line wins; otherwise
 * the runs of Latin-script tags (two or more words) are kept. Plain tag text comes
 * back unchanged.
 * @param text - the DNA or feature text.
 * @returns the tags, or `''` when there are none.
 */
export function promptTags(text) {
  const source = String(text ?? '').trim()
  if (source === '') return ''
  const cjk = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/
  if (!cjk.test(source)) return source
  const labelled = source
    .split('\n')
    .map((line) => /^\s*(?:外观标签|标签|提示词|tags?|prompt)\s*[:：]\s*(.+)$/i.exec(line)?.[1]?.trim() ?? '')
    .filter((line) => line !== '' && !cjk.test(line))
  if (labelled.length > 0) return labelled.join(', ')
  const runs = source.match(/[A-Za-z0-9][A-Za-z0-9 _\-:'.()]*(?:,\s*[A-Za-z0-9][A-Za-z0-9 _\-:'.()]*)*/g) ?? []
  return runs
    .map((run) => run.trim().replace(/[.\s]+$/, ''))
    .filter((run) => /[A-Za-z]/.test(run) && /[ ,]/.test(run))
    .join(', ')
}

/**
 * The text block that tells the prompt writer who these characters are.
 * @param characters - the characters to describe.
 * @returns the block, or `''`.
 */
export function characterBlock(characters) {
  if (characters.length === 0) return ''
  return characters
    .map((character) => {
      const lines = [`【${character.name}】`, `固定特征：${character.fixedFeatures || '（未填写）'}`]
      for (const row of character.variableFeatures) lines.push(`可选特征「${row.name}」：${row.prompt}`)
      if (character.negative) lines.push(`不要出现：${character.negative}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

/**
 * Turn a model's JSON reply into a character draft (not saved).
 * @param value - the parsed reply.
 * @returns a draft with the character fields filled.
 */
export function draftFromModel(value) {
  const pick = (...keys) => {
    for (const key of keys) {
      const v = value?.[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
      if (Array.isArray(v) && v.length > 0) return v.map((x) => String(x).trim()).filter(Boolean).join(', ')
    }
    return ''
  }
  const variable = Array.isArray(value?.variableFeatures)
    ? value.variableFeatures
    : Array.isArray(value?.outfits)
      ? value.outfits
      : []
  return {
    name: pick('name', 'characterName'),
    keywords: normalizeKeywords(value?.keywords ?? pick('keyword')),
    fixedFeatures: pick('fixedFeatures', 'dna', 'fixed'),
    variableFeatures: normalizeVariable(
      variable.map((row) => (typeof row === 'string' ? { name: '', prompt: row } : { name: row?.name ?? row?.title, prompt: row?.prompt ?? row?.tags }))
    ),
    negative: pick('negative', 'negativePrompt'),
    notes: pick('notes', 'note', 'comment')
  }
}
