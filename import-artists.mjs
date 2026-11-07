/**
 * dsh-nai-imagegen — build the artist index from one or more archives.
 *
 * A one-off (and re-runnable) utility rather than something the plugin does at
 * startup: the main archive is 217 MB, and re-scanning it every boot would be
 * absurd. The plugin reads the index; this writes it.
 *
 * The archives stay the single source of truth for the images. Nothing is
 * copied: the index records each reference image's and thumbnail's byte range
 * inside its own archive, and the plugin reads those ranges on demand.
 *
 * Several archives are merged in the order given. An entry whose positive and
 * negative prompts match one already indexed is dropped as a renamed copy, and
 * the earlier archive keeps its name.
 *
 * Usage:
 *   node import-artists.mjs <archive.json> [more.json …] [--out index.json]
 *   node import-artists.mjs <archive.json> <index.json>      (older form)
 *
 * Defaults to `$DSH_HOME/nai-imagegen/artists/index.json`.
 *
 * The index is never edited in place: what the user saves from the workbench
 * lives beside it in `artists/user.json` (lib/artist-library.js). Overrides there
 * are keyed by archive id, which is an entry's position here, so re-indexing a
 * different set of archives can move them onto other entries; this script warns
 * when that file holds overrides.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { buildIndex } from './lib/artists.js'

const ROW_ID = 'nai-imagegen'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

const args = process.argv.slice(2)
let out = null
const files = []
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out') out = args[(i += 1)]
  // Older docs pass --apply; writing is the only mode, so it is accepted and ignored.
  else if (args[i] === '--apply') continue
  else files.push(args[i])
}
// The older two-argument form named the index second; it does not exist yet as
// an archive, which is how it is told apart from a second archive.
if (out === null && files.length === 2 && !existsSync(files[1])) out = files.pop()
if (files.length === 0) {
  console.error('usage: node import-artists.mjs <archive.json> [more.json …] [--out index.json]')
  process.exit(2)
}
const missing = files.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error(`not found: ${missing.join(', ')}`)
  process.exit(2)
}
const indexPath = resolve(out ?? join(HOME, ROW_ID, 'artists', 'index.json'))
const sourceFiles = files.map((file) => resolve(file))

for (const file of sourceFiles) console.log(`source : ${file}`)
console.log(`index  : ${indexPath}`)
const started = Date.now()
const summary = await buildIndex({ sourceFiles, indexPath })
const seconds = ((Date.now() - started) / 1000).toFixed(1)

console.log(`\nindexed ${summary.count} artists in ${seconds}s`)
for (const row of summary.sources) console.log(`  ${row.group} : ${row.count}`)
console.log(`  with a reference image : ${summary.withImages}`)
console.log(`  with a thumbnail       : ${summary.withThumbs}`)
console.log(`  renamed copies dropped : ${summary.duplicates}`)
if (summary.skipped.length > 0) {
  console.log(`  skipped                : ${summary.skipped.length}`)
  for (const row of summary.skipped.slice(0, 5)) console.log(`    ${row.file} @${row.offset}  ${row.reason}`)
}
try {
  const user = JSON.parse(readFileSync(join(dirname(indexPath), 'user.json'), 'utf8'))
  const edited = Object.keys(user?.overrides ?? {}).length
  if (edited > 0) {
    console.log(`  note: ${edited} saved edit(s) in user.json are keyed by archive position; check them if the archive order changed`)
  }
} catch {
  // no user document beside this index
}
const heapMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)
console.log(`  heap in use at the end : ${heapMb} MB`)
