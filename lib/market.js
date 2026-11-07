/**
 * dsh-nai-imagegen — the tag market 「标签超市」.
 *
 * A clickable palette of tags, fed by a catalog the user imports whole. The
 * format is nai-dbgen's tag envelope, so a catalog exported there imports here:
 *
 *   { "schemaVersion": 1, "kind": "tag",
 *     "libraries": [{ "id": "lib1", "name": "…" }],
 *     "entries":   [{ "id": "e1", "libraryId": "lib1", "key": "服装·上衣·衬衫", "value": "white shirt" }] }
 *
 * The `key` is the category path, `·`-separated, ending in the tag's name. The
 * browser builds the category tabs from it, so a catalog whose keys were never
 * sorted into categories (or still carry review placeholders) is refused at the
 * door rather than rendered as a mess.
 *
 * Replace-only: an import overwrites the whole file, through a temp file and a
 * rename, so a failed write leaves the previous catalog in place.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_DIR } from './config.js'

/** The catalog file. */
export const MARKET_FILE = join(STATE_DIR, 'market.json')
/** How many problems a refusal lists before summarising the rest. */
const MAX_LISTED = 6

/**
 * Check one catalog against nai-dbgen's rules (`market-catalog.store.js`).
 * @param catalog - the parsed JSON.
 * @returns the problems found, in Chinese; empty when the catalog is valid.
 */
export function validateCatalog(catalog) {
  const problems = []
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) return ['文件内容必须是一个 JSON 对象']
  if (catalog.kind !== 'tag') problems.push(`kind 必须是 "tag"（现在是 ${JSON.stringify(catalog.kind ?? null)}）`)
  if (!Array.isArray(catalog.libraries)) problems.push('缺少 libraries 数组')
  if (!Array.isArray(catalog.entries)) problems.push('缺少 entries 数组')
  if (problems.length > 0) return problems

  const libraryIds = new Set()
  catalog.libraries.forEach((library, index) => {
    const id = typeof library?.id === 'string' ? library.id.trim() : ''
    if (id === '') problems.push(`libraries[${index}] 缺少 id`)
    else if (libraryIds.has(id)) problems.push(`库 id 重复：${id}`)
    else libraryIds.add(id)
  })

  const entryIds = new Set()
  catalog.entries.forEach((entry, index) => {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    const where = id === '' ? `entries[${index}]` : `条目 ${id}`
    if (id === '') problems.push(`entries[${index}] 缺少 id`)
    else if (entryIds.has(id)) problems.push(`条目 id 重复：${id}`)
    else entryIds.add(id)
    const libraryId = typeof entry?.libraryId === 'string' ? entry.libraryId.trim() : ''
    if (!libraryIds.has(libraryId)) problems.push(`${where} 的 libraryId「${libraryId}」不存在`)
    const key = typeof entry?.key === 'string' ? entry.key : ''
    const parts = key.split('·').map((part) => part.trim())
    if (parts.length < 2 || parts.some((part) => part === '')) {
      problems.push(`${where} 的 key「${key}」至少要有「分类·名称」两段，且每段不能为空`)
    } else if (parts.some((part) => part.startsWith('待审核-') || part.startsWith('待命名-') || part === '待分类')) {
      problems.push(`${where} 的 key「${key}」尚未完成分类或命名审核`)
    }
    if (typeof entry?.value !== 'string' || entry.value.trim() === '') problems.push(`${where} 的 value 为空`)
  })
  if (catalog.entries.length === 0) problems.push('entries 里至少要有一条标签')
  return problems
}

/**
 * A short content hash, so the browser can tell a replaced catalog from the one
 * its inserted-tag records refer to.
 * @param text - the stored file text.
 * @returns 12 hex characters, or `''` for no catalog.
 */
export function signatureOf(text) {
  return text === null || text === '' ? '' : createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** @returns `{ catalog, signature }`; `catalog` is `null` before the first import. */
export async function loadMarket() {
  let text
  try {
    text = await readFile(MARKET_FILE, 'utf8')
  } catch {
    return { catalog: null, signature: '' }
  }
  try {
    return { catalog: JSON.parse(text), signature: signatureOf(text) }
  } catch {
    // A hand-damaged file reads as "nothing imported" rather than breaking the panel.
    return { catalog: null, signature: '' }
  }
}

/**
 * Replace the catalog.
 * @param catalog - the parsed catalog (or its JSON text).
 * @returns `{ ok, count, signature }`.
 * @throws an Error with `status: 400` and `issues` when the catalog is invalid.
 */
export async function importMarket(catalog) {
  let value = catalog
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (error) {
      throw Object.assign(new Error(`标签超市文件不是有效的 JSON：${error.message}`), { status: 400 })
    }
  }
  const problems = validateCatalog(value)
  if (problems.length > 0) {
    const listed = problems.slice(0, MAX_LISTED).map((line) => `· ${line}`).join('\n')
    const more = problems.length > MAX_LISTED ? `\n……另有 ${problems.length - MAX_LISTED} 处问题` : ''
    throw Object.assign(new Error(`标签超市没有导入，共 ${problems.length} 处问题：\n${listed}${more}`), {
      status: 400,
      issues: problems.slice(0, 50)
    })
  }
  const text = `${JSON.stringify(value, null, 2)}\n`
  await mkdir(dirname(MARKET_FILE), { recursive: true })
  const temp = `${MARKET_FILE}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, MARKET_FILE)
  return { ok: true, count: value.entries.length, signature: signatureOf(text) }
}
