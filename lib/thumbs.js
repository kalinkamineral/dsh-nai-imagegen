/**
 * dsh-nai-imagegen — square thumbnails for the native panel.
 *
 * The DSH Go `image` / `gallery` components accept only two sources: a
 * `data:image/…` URL of at most 64 KiB, or `asset:<path>` inside the plugin's
 * `dshGo.assets` directory. A cover here is a 832×1216 PNG of a few hundred
 * kilobytes, so neither fits: a data URL would blow the 32 KiB panel budget the
 * moment two of them share a view.
 *
 * `asset:` is the one that scales, because the bytes never enter the view JSON —
 * the bridge fetches the file by path. So this module writes small WebP copies
 * into `<package>/assets/thumbs/` and returns the `asset:` reference.
 *
 * Names carry the source's mtime, which is what makes a regenerated cover show up
 * without a cache to invalidate: a new mtime is a new file name. Older files with
 * the same key prefix are removed on the next write.
 *
 * `sharp` belongs to the harness install, not to this package (the plugin has no
 * dependencies), so it is resolved through the harness's own entry point and not
 * by bare import. Without it the panel simply has no pictures — never an error.
 */
import { createRequire } from 'node:module'
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the thumbnails are written, relative to the `assets` directory. */
const THUMB_REL = 'thumbs'
/** Absolute directory, next to `index.js`. */
const THUMB_DIR = join(import.meta.dirname, '..', 'assets', THUMB_REL)
/** Where full-size copies live, so the app's viewer can save the real picture. */
const FULL_REL = 'full'
const FULL_DIR = join(import.meta.dirname, '..', 'assets', FULL_REL)
/** How many full-size renders to keep: each is a couple of megabytes. */
const FULL_KEEP = 24
/** Square edge in pixels: sharp at panel density, small on disk. */
const THUMB_SIZE = 360
/** WebP quality; 70 keeps a portrait around 15–25 KB. */
const QUALITY = 70

/** The sharp module, once resolved (`null` when unavailable). */
let sharpModule
let sharpResolved = false

/**
 * Resolve the harness's `sharp`.
 *
 * The plugin's own tree has no `node_modules`, so a bare `import('sharp')` fails;
 * the dependency lives in the harness install. `process.argv[1]` is the `dsh`
 * entry point that started this process, so resolving from there follows the
 * install that is actually running. `/opt/dsh` is this phone's checkout, kept as
 * the fallback.
 *
 * @returns the sharp function, or `null`.
 */
function loadSharp() {
  if (sharpResolved) return sharpModule
  sharpResolved = true
  const bases = []
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') bases.push(process.argv[1])
  bases.push('/opt/dsh/package.json')
  for (const base of bases) {
    try {
      sharpModule = createRequire(base)('sharp')
      return sharpModule
    } catch {
      // try the next base
    }
  }
  sharpModule = null
  return null
}

/**
 * Make one thumbnail and return its `asset:` reference.
 *
 * @param sourcePath - absolute path of the original image.
 * @param key - stable name for this picture (`char-<id>`, `shot-<name>`).
 * @param options - `{ size?, quality? }`.
 * @returns `asset:thumbs/<key>-<mtime>.webp`, or `null` when it cannot be made.
 */
export async function thumbRef(sourcePath, key, options = {}) {
  const sharp = loadSharp()
  if (sharp === null) return null
  const safeKey = String(key ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  if (safeKey === '') return null
  let info
  try {
    info = await stat(sourcePath)
  } catch {
    return null
  }
  if (!info.isFile()) return null
  const name = `${safeKey}-${Math.round(info.mtimeMs)}.webp`
  const target = join(THUMB_DIR, name)
  try {
    await stat(target)
    return `asset:${THUMB_REL}/${name}`
  } catch {
    // not made yet
  }
  try {
    await mkdir(THUMB_DIR, { recursive: true })
    const size = Number(options.size) > 0 ? Math.round(Number(options.size)) : THUMB_SIZE
    const quality = Number(options.quality) > 0 ? Math.round(Number(options.quality)) : QUALITY
    await sharp(sourcePath)
      .rotate()
      .resize({ width: size, height: size, fit: 'cover', position: 'attention' })
      .webp({ quality })
      .toFile(target)
    await prune(safeKey, name)
    return `asset:${THUMB_REL}/${name}`
  } catch {
    return null
  }
}

/**
 * Remove older files of the same key, so a changed cover does not leave its
 * predecessor behind forever.
 * @param key - the sanitized key.
 * @param keep - the file name to keep.
 */
async function prune(key, keep) {
  try {
    const names = await readdir(THUMB_DIR)
    await Promise.all(
      names
        .filter((name) => name.startsWith(`${key}-`) && name !== keep)
        .map((name) => unlink(join(THUMB_DIR, name)).catch(() => {}))
    )
  } catch {
    // a directory that cannot be read has nothing to prune
  }
}

/**
 * Publish a full-size copy of a render inside the package.
 *
 * The app's full-screen viewer saves whatever image it was handed, and saving
 * from there is the one path that reaches the phone's album (the engine cannot
 * talk to MediaStore). Handing it a 360 px thumbnail would save a thumbnail, so
 * the newest renders are copied whole. Only the last `FULL_KEEP` are kept.
 *
 * @param sourcePath - the rendered PNG.
 * @param name - its file name (already a safe timestamp name).
 * @returns `asset:full/<name>`, or `null` when the copy failed.
 */
export async function fullRef(sourcePath, name) {
  const sharp = loadSharp()
  if (sharp === null) return null
  const safe = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  if (!safe.toLowerCase().endsWith('.png')) return null
  const stem = safe.replace(/\.png$/i, '')
  const target = join(FULL_DIR, `${stem}.webp`)
  try {
    await mkdir(FULL_DIR, { recursive: true })
    try {
      await stat(target)
    } catch {
      // The bridge serves at most 1 MiB per asset, and a 1024 px PNG is often 2 MB.
      // Re-encode at the same pixel size, stepping the quality down until it fits:
      // the viewer still saves the full picture, just as WebP.
      for (const quality of [92, 86, 80, 72, 64]) {
        await sharp(sourcePath).webp({ quality, effort: 4 }).toFile(target)
        const info = await stat(target)
        if (info.size <= 1_000_000) break
      }
    }
    await pruneFull(`${stem}.webp`)
    return `asset:${FULL_REL}/${stem}.webp`
  } catch {
    return null
  }
}

/**
 * Which renders have a full-size copy.
 * @returns a Map from the render file name (`<stamp>.png`) to its `asset:` ref.
 */
export async function fullIndex() {
  const out = new Map()
  try {
    for (const name of await readdir(FULL_DIR)) {
      if (!name.toLowerCase().endsWith('.webp')) continue
      out.set(`${name.replace(/\.webp$/i, '')}.png`, `asset:${FULL_REL}/${name}`)
    }
  } catch {
    // no copies yet
  }
  return out
}

/**
 * Keep the newest `FULL_KEEP` copies.
 * @param keepName - the one just written, always kept.
 */
async function pruneFull(keepName) {
  try {
    const names = await readdir(FULL_DIR)
    const rows = []
    for (const name of names) {
      const info = await stat(join(FULL_DIR, name)).catch(() => null)
      if (info !== null) rows.push({ name, mtime: info.mtimeMs })
    }
    rows.sort((a, b) => b.mtime - a.mtime)
    const doomed = rows.filter((row, index) => index >= FULL_KEEP && row.name !== keepName)
    await Promise.all(doomed.map((row) => unlink(join(FULL_DIR, row.name)).catch(() => {})))
  } catch {
    // nothing to prune
  }
}
