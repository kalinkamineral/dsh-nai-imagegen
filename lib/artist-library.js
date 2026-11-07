/**
 * dsh-nai-imagegen — the artist strings the user saved, merged over the archive.
 *
 * The archive index (lib/artists.js) is built from read-only files and rebuilt
 * wholesale by import-artists.mjs, so nothing the user saves from the workbench
 * may live in it. Instead one small document sits beside it:
 *
 *   STATE_DIR/artists/user.json
 *     { overrides: { [archiveId]: { name?, positivePrompt?, negativePrompt?, cover?, updatedAt } },
 *       entries:   [{ id, name, positivePrompt, negativePrompt, cover?, createdAt, updatedAt }],
 *       nextId }
 *   STATE_DIR/artists/covers/<id>.png
 *
 * `overrides` edits an archive entry in place (「保存到当前画师串」, 「替换画师串预览」)
 * without touching the archive; `entries` are strings the user created
 * (「新建画师串」). The merged view is what every caller resolves ids against.
 *
 * Ids stay stable: an archive entry's id is its position in the index, and a
 * user entry's id starts at 100000 and is never reused, so a deleted entry's id
 * cannot silently start meaning a different style in an old config or sidecar.
 */
import { readdir, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_DIR } from './config.js'
import { loadIndex } from './artists.js'

/** The user document. */
export const USER_ARTISTS_FILE = join(STATE_DIR, 'artists', 'user.json')
/** Where cover PNGs are kept. */
export const COVERS_DIR = join(STATE_DIR, 'artists', 'covers')
/** First id of a user entry; archive ids are positions and stay below it. */
export const USER_ARTIST_BASE = 100000
/** The display group of user entries. */
export const USER_GROUP = '我的画师串'

/** The PNG signature, checked before a file is accepted as a cover. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** @returns an ISO timestamp. */
const now = () => new Date().toISOString()

/** @returns the user document, normalised; an absent or broken file reads as empty. */
export async function readUserArtists() {
  let raw = null
  try {
    raw = JSON.parse(await readFile(USER_ARTISTS_FILE, 'utf8'))
  } catch {
    raw = null
  }
  const overrides = {}
  for (const [key, row] of Object.entries(raw?.overrides ?? {})) {
    const id = Number(key)
    if (!Number.isInteger(id) || id < 0 || id >= USER_ARTIST_BASE || row === null || typeof row !== 'object') continue
    const kept = {}
    for (const field of ['name', 'positivePrompt', 'negativePrompt', 'cover', 'updatedAt']) {
      if (typeof row[field] === 'string') kept[field] = row[field]
    }
    overrides[String(id)] = kept
  }
  const entries = (Array.isArray(raw?.entries) ? raw.entries : [])
    .filter((row) => row !== null && typeof row === 'object' && Number.isInteger(Number(row.id)) && Number(row.id) >= USER_ARTIST_BASE)
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? '').trim() || '未命名画师串',
      positivePrompt: String(row.positivePrompt ?? ''),
      negativePrompt: String(row.negativePrompt ?? ''),
      ...(typeof row.cover === 'string' && row.cover !== '' ? { cover: row.cover } : {}),
      createdAt: String(row.createdAt || now()),
      updatedAt: String(row.updatedAt || now())
    }))
  const highest = entries.reduce((max, row) => Math.max(max, row.id + 1), USER_ARTIST_BASE)
  const nextId = Math.max(highest, Number.isInteger(Number(raw?.nextId)) ? Number(raw.nextId) : USER_ARTIST_BASE)
  return { overrides, entries, nextId }
}

/** @param doc - the user document to store (temp file + rename). */
async function writeUserArtists(doc) {
  await mkdir(dirname(USER_ARTISTS_FILE), { recursive: true })
  const temp = `${USER_ARTISTS_FILE}.tmp`
  await writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  await rename(temp, USER_ARTISTS_FILE)
}

/**
 * @param id - an artist id.
 * @returns the absolute path of its cover PNG (which may not exist).
 */
export function coverFileOf(id) {
  return join(COVERS_DIR, `${Number(id)}.png`)
}

/** @returns the cover file names present on disk. */
async function coverNames() {
  try {
    return new Set(await readdir(COVERS_DIR))
  } catch {
    return new Set()
  }
}

/**
 * The merged artist view: archive entries with the user's overrides applied
 * (marked `edited`), then the user's own entries (group 「我的画师串」, `user`).
 *
 * @param config - the loaded configuration (`artistIndex`).
 * @returns `{ index, sourceFile, sources, entries, byId, groups, userCount }`;
 *   `index` is the raw archive index or `null` when none was imported.
 */
export async function loadArtists(config) {
  const index = await loadIndex(config.artistIndex)
  const user = await readUserArtists()
  const covers = await coverNames()
  const entries = []
  for (const [position, entry] of (index?.entries ?? []).entries()) {
    const override = user.overrides[String(position)]
    const hasCover = covers.has(`${position}.png`) && override !== undefined
    entries.push({
      ...entry,
      id: position,
      ...(override?.name ? { name: override.name } : {}),
      ...(override?.positivePrompt !== undefined ? { positivePrompt: override.positivePrompt } : {}),
      ...(override?.negativePrompt !== undefined ? { negativePrompt: override.negativePrompt } : {}),
      edited: override !== undefined,
      user: false,
      hasCover,
      coverVersion: hasCover ? (override.updatedAt ?? '') : ''
    })
  }
  for (const row of user.entries) {
    const hasCover = covers.has(`${row.id}.png`)
    entries.push({
      id: row.id,
      name: row.name,
      sequence: row.id,
      positivePrompt: row.positivePrompt,
      negativePrompt: row.negativePrompt,
      chamiPositivePrompt: '',
      chamiNegativePrompt: '',
      group: USER_GROUP,
      source: '',
      image: null,
      thumb: null,
      edited: false,
      user: true,
      hasCover,
      coverVersion: hasCover ? row.updatedAt : '',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    })
  }
  const sources = index?.sources ?? []
  const groups = sources.map((row) => ({ ...row }))
  if (user.entries.length > 0) groups.push({ group: USER_GROUP, count: user.entries.length, user: true })
  return {
    index,
    sourceFile: index?.sourceFile ?? '',
    sources,
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    groups,
    userCount: user.entries.length
  }
}

/**
 * @param view - the merged view.
 * @param id - an artist id.
 * @returns the entry, or `null`.
 */
export function artistById(view, id) {
  const n = Number(id)
  if (!Number.isInteger(n) || n < 0) return null
  return view?.byId?.get(n) ?? null
}

/**
 * Copy a gallery PNG in as one entry's cover.
 * @param id - the artist id.
 * @param pngPath - an already validated absolute path inside the gallery.
 */
async function writeCover(id, pngPath) {
  const bytes = await readFile(pngPath)
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw Object.assign(new Error('封面必须是图库里的 PNG 图片'), { status: 400 })
  }
  await mkdir(COVERS_DIR, { recursive: true })
  const target = coverFileOf(id)
  const temp = `${target}.tmp`
  await writeFile(temp, bytes)
  await rename(temp, target)
}

/** @returns whether an archive id exists in the index. */
function isArchiveId(index, id) {
  return Number.isInteger(id) && id >= 0 && id < USER_ARTIST_BASE && id < (index?.entries?.length ?? 0)
}

/**
 * Save an artist string from the workbench.
 *
 *   - `id` of an archive entry → write (replace) its override;
 *   - `id` of a user entry     → update it;
 *   - no `id`                  → create a new user entry.
 *
 * @param config - the loaded configuration.
 * @param input - `{ id?, name, positivePrompt, negativePrompt }`.
 * @param coverPath - an already validated gallery PNG to use as the cover, or `null`.
 * @returns `{ id, entry }` with the merged entry.
 */
export async function saveUserArtist(config, input, coverPath = null) {
  const name = String(input?.name ?? '').trim()
  if (name === '') throw Object.assign(new Error('请填写画师串名称'), { status: 400 })
  const positivePrompt = String(input?.positivePrompt ?? '').trim()
  const negativePrompt = String(input?.negativePrompt ?? '').trim()
  const index = await loadIndex(config.artistIndex)
  const doc = await readUserArtists()
  const hasId = input?.id !== undefined && input?.id !== null && input?.id !== ''
  const requested = hasId ? Number(input.id) : null
  let id

  if (requested !== null && isArchiveId(index, requested)) {
    id = requested
    const previous = doc.overrides[String(id)] ?? {}
    doc.overrides[String(id)] = {
      name,
      positivePrompt,
      negativePrompt,
      ...(coverPath !== null || previous.cover ? { cover: `${id}.png` } : {}),
      updatedAt: now()
    }
  } else if (requested !== null && requested >= USER_ARTIST_BASE) {
    const at = doc.entries.findIndex((row) => row.id === requested)
    if (at < 0) throw Object.assign(new Error('当前画师串已不存在，请重新选择'), { status: 404 })
    id = requested
    doc.entries[at] = {
      ...doc.entries[at],
      name,
      positivePrompt,
      negativePrompt,
      ...(coverPath !== null ? { cover: `${id}.png` } : {}),
      updatedAt: now()
    }
  } else if (requested !== null) {
    throw Object.assign(new Error(`没有 id=${input.id} 的画师串`), { status: 404 })
  } else {
    id = doc.nextId
    doc.nextId = id + 1
    doc.entries.push({
      id,
      name,
      positivePrompt,
      negativePrompt,
      ...(coverPath !== null ? { cover: `${id}.png` } : {}),
      createdAt: now(),
      updatedAt: now()
    })
  }
  // The cover first: a failed copy must not leave a record pointing at a file
  // that was never written.
  if (coverPath !== null) await writeCover(id, coverPath)
  await writeUserArtists(doc)
  return { id, entry: artistById(await loadArtists(config), id) }
}

/**
 * Replace only the cover of one entry (「替换画师串预览」); the text is untouched.
 * @param config - the loaded configuration.
 * @param id - an archive or user id.
 * @param coverPath - an already validated gallery PNG.
 * @returns `{ id, entry }`.
 */
export async function setArtistCover(config, id, coverPath) {
  const n = Number(id)
  const index = await loadIndex(config.artistIndex)
  const doc = await readUserArtists()
  if (isArchiveId(index, n)) {
    doc.overrides[String(n)] = { ...(doc.overrides[String(n)] ?? {}), cover: `${n}.png`, updatedAt: now() }
  } else {
    const at = doc.entries.findIndex((row) => row.id === n)
    if (at < 0) throw Object.assign(new Error('请先选择画师串'), { status: 404 })
    doc.entries[at] = { ...doc.entries[at], cover: `${n}.png`, updatedAt: now() }
  }
  await writeCover(n, coverPath)
  await writeUserArtists(doc)
  return { id: n, entry: artistById(await loadArtists(config), n) }
}

/**
 * Delete a user entry, or revert an archive entry to its archived text and
 * image by dropping its override. The cover file goes with either.
 * @param config - the loaded configuration.
 * @param id - an archive or user id.
 * @returns `{ id, removed: 'entry' | 'override', entry }`; `entry` is the
 *   reverted archive entry, or `null` for a deleted user entry.
 */
export async function deleteUserArtist(config, id) {
  const n = Number(id)
  const doc = await readUserArtists()
  let removed
  if (n >= USER_ARTIST_BASE) {
    const before = doc.entries.length
    doc.entries = doc.entries.filter((row) => row.id !== n)
    if (doc.entries.length === before) throw Object.assign(new Error(`没有 id=${id} 的自建画师串`), { status: 404 })
    removed = 'entry'
  } else {
    if (doc.overrides[String(n)] === undefined) throw Object.assign(new Error(`画师串 #${id} 没有改动，无需还原`), { status: 404 })
    delete doc.overrides[String(n)]
    removed = 'override'
  }
  await writeUserArtists(doc)
  await rm(coverFileOf(n), { force: true })
  const entry = removed === 'override' ? artistById(await loadArtists(config), n) : null
  return { id: n, removed, entry }
}
