/**
 * Test entry point.
 *
 * `tests/verify.mjs` exercises the host half, and the host half logs through
 * `lib/log.js` into `$DSH_HOME/nai-imagegen/logs`. Without this wrapper every
 * `npm run verify` writes its deliberately failing cases (a 32×32 mask, a
 * missing `__definitely_missing__.png`, an unsupported director tool…) into the
 * user's real render log, where the panel then lists them as failed renders.
 *
 * `config.js` and `log.js` read `DSH_HOME` at import time, so it has to be set
 * before the module graph loads — hence the dynamic import instead of a static
 * one.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-nai-verify-'))

await import('./verify.mjs')
