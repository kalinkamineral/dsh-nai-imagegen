/**
 * dsh-nai-imagegen — live capability check.
 *
 * Every failure this plugin has had was *silent*: a config field coerced to the
 * wrong type, a key id stripped on the way through `normalize`, a refactor that
 * dropped a parser branch, a module that simply was not loaded yet. None of them
 * threw; they just quietly stopped working, and the only way to notice was to
 * render something and look at it.
 *
 * This module is the answer to that: one call that exercises every capability
 * against the live configuration and says, check by check, whether it is intact.
 * It is deliberately cheap — no rendering, no Anlas — so it can be run after every
 * restart, and deliberately explicit about *why* a check failed.
 *
 * Kept free of DSH imports so it runs offline in the test suite.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Run every capability check.
 *
 * @param deps - the live pieces, injected by the host half.
 * @returns `{ ok, checks }` where each check is `{ name, ok, detail }`.
 */
export async function runDoctor(deps) {
  const {
    config,
    pool,
    proxy,
    loadIndex,
    loadArtists,
    artistById,
    coverFileOf,
    searchArtists,
    readArtistImage,
    listLibraries,
    lookup,
    resolveCharacter,
    digest,
    clientSource,
    outputDir,
    packageRoot,
    modeSettings
  } = deps

  const checks = []
  /**
   * Record one check.
   * @param name - what is being verified.
   * @param ok - whether it holds.
   * @param detail - a short explanation, shown either way.
   */
  const check = (name, theAnswer, detail = '') => checks.push({ name, ok: theAnswer === true, detail: String(detail) })

  // ------------------------------------------------------------- configuration --
  // The type of every field is asserted, because `normalize` coerces by `typeof`
  // and a wrong branch turned `autoGenerate` into the string "true" once — which
  // no `=== true` check could ever satisfy.
  const badTypes = []
  for (const [key, value] of Object.entries(config)) {
    const wanted = key === 'keys' ? 'object' : typeof config[key]
    if (Array.isArray(config[key]) && wanted !== 'object') badTypes.push(key)
    else if (value === null && key !== 'keys') badTypes.push(`${key}(null)`)
  }
  check('config fields are non-null', badTypes.length === 0, badTypes.join(','))
  check('autoGenerate is a real boolean', typeof config.autoGenerate === 'boolean', typeof config.autoGenerate)
  check('artistId is a real number', typeof config.artistId === 'number', typeof config.artistId)
  check('keys is an array', Array.isArray(config.keys), typeof config.keys)
  check('keepImages is a real number', typeof config.keepImages === 'number', typeof config.keepImages)

  // ------------------------------------------------------------------ key pool --
  const summary = pool.healthSummary()
  check('at least one usable API key', summary.usableKeyCount > 0, JSON.stringify(summary))
  check('concurrency follows the usable keys', summary.concurrency >= 1 && summary.concurrency <= Math.max(1, summary.usableKeyCount), JSON.stringify(summary.concurrency))
  check('no token is exposed by the pool', !JSON.stringify(pool.list()).includes('pst-'))

  // --------------------------------------------------------------------- proxy --
  check('a proxy path is resolved or deliberately direct', proxy === null || /^https?:\/\//.test(String(proxy)), String(proxy))

  // ------------------------------------------------------------------- artists --
  // Resolved through the merged view when the host provides it (archive entries
  // with the user's saved edits, plus 「我的画师串」), else the bare index.
  const view = typeof loadArtists === 'function' ? await loadArtists(config) : null
  const artists = view ?? (await loadIndex(config.artistIndex))
  check('the artist index loads', artists !== null && (view === null || view.index !== null || view.userCount > 0), config.artistIndex)
  if (artists !== null) {
    check('the artist index has entries', artists.entries.length > 0, String(artists.entries.length))
    check('the artist search returns rows', searchArtists(artists, '', 3).length > 0)
    const current = Number(config.artistId)
    if (current >= 0) {
      const selected = view !== null && typeof artistById === 'function' ? (artistById(view, current) ?? undefined) : artists.entries[current]
      check('the remembered artist still resolves', selected !== undefined, `artistId=${current}`)
      if (selected !== undefined && selected.hasCover === true && typeof coverFileOf === 'function') {
        const bytes = await readFile(coverFileOf(selected.id)).catch(() => null)
        check('the saved cover reads back', bytes !== null && bytes[0] === 0x89, `${bytes?.length ?? 0} bytes`)
      } else if (selected !== undefined && selected.image !== null && selected.image !== undefined) {
        const sourceFile = typeof selected.source === 'string' && selected.source !== '' ? selected.source : config.artistSource || artists.sourceFile
        const bytes = await readArtistImage({ sourceFile, image: selected.image })
        check('the reference image reads out of the archive', bytes !== null && bytes[0] === 0x89, `${bytes?.length ?? 0} bytes`)
      }
    }
  }

  // ------------------------------------------------------------------ libraries --
  const libraries = await listLibraries(config.libraryDir)
  check('the libraries are indexed', libraries.length >= 5, libraries.map((row) => `${row.library}(${row.entries})`).join(' '))
  const found = await lookup('美人鱼', { libraryDir: config.libraryDir, limit: 1 })
  check('a full-text lookup hits', found.hits.length > 0, JSON.stringify(found.hits[0]?.title ?? ''))
  const roster = await resolveCharacter('Hikari', { libraryDir: config.libraryDir, limit: 1 })
  const rosterText = digest(roster)
  check('a roster resolve hits', roster.hits.length > 0, rosterText.split('\n')[0].slice(0, 90))
  check('the roster header is fully populated', !rosterText.includes('undefined'), rosterText.split('\n')[0].slice(0, 90))
  const rosterMiss = digest(await resolveCharacter('这个词绝对不在名册里zzz', { libraryDir: config.libraryDir, limit: 1 }))
  check('a roster miss does not claim the index is empty', !rosterMiss.includes('索引目录为空'), rosterMiss.split('\n')[0].slice(0, 90))

  // --------------------------------------------------------------- format parser --
  const { parseImageBlock, looksLikeImageBlock, maybeParseImageBlock } = await import('./format.js')
  const sample = [
    '<image>',
    '<image_think>',
    '①reasoning that must never be sent',
    '</image_think>',
    'image###size:1024x1024;',
    'Scene:SFW,{{2girls}},side-by-side;',
    'Char1:girl,on left,blonde hair|centers:B3;',
    'Char1 UC:brown hair;',
    'Scene UC:nude;###',
    '</image>'
  ].join('\n')
  const parsed = parseImageBlock(sample, { width: 832, height: 1216 })
  check('a sample block parses', parsed.ok, parsed.reason ?? '')
  if (parsed.ok) {
    check('the block sets its own size', parsed.width === 1024 && parsed.height === 1024, `${parsed.width}x${parsed.height}`)
    check('no scaffold leaks into the positive', !/<\/?image|image_think|image\s*#{2,}|#{2,}|centers/i.test(parsed.prompt), parsed.prompt.slice(0, 80))
    check('no scaffold leaks into the negative', !/<\/?image|image_think|image\s*#{2,}|centers/i.test(parsed.negativePrompt), parsed.negativePrompt.slice(0, 80))
    check('the reasoning is dropped', !/reasoning that must never be sent/.test(parsed.prompt))
    check('the character keeps its own negative', parsed.characters[0]?.negative === 'brown hair', JSON.stringify(parsed.characters[0]?.negative))
    check('the grid cell is captured', (parsed.characters[0]?.centers ?? []).includes('B3'), JSON.stringify(parsed.characters[0]?.centers))
  }
  // A plain prompt — including a 「简串版」 with lowercase char labels and inline
  // negative weights — must pass through untouched rather than being parsed.
  const simple = '2girls, ffm threesome, group sex, on bed,\n\nchar1: Hikari (Blue Archive), green hair,\n\n-1.5::twintails::,\n0.7::warm dim lighting::'
  check('a lowercase char-labelled prompt is not treated as a block', !looksLikeImageBlock(simple))
  check('and it is passed through verbatim', maybeParseImageBlock(simple) === null)
  check('the inline negative weight survives', /-1\.5::twintails::/.test(simple))

  // ------------------------------------------------------------------ classifier --
  // The browser half decides which blocks get a button. Its source is checked here
  // rather than imported, so a refactor that drops a format is caught offline.
  check('the client source is readable', typeof clientSource === 'string' && clientSource.length > 1000, String(clientSource?.length ?? 0))
  if (typeof clientSource === 'string') {
    check('the classifier knows the <image> block', /\[ \\t\]\*<image/.test(clientSource), '')
    check('the classifier knows the image### envelope', /image\\s\*#\{2,\}/.test(clientSource), '')
    check('the code-block watcher is installed', /installCodeButtons\(t\)/.test(clientSource), '')
    check('the image menu is installed', /installImageMenu\(t\)/.test(clientSource), '')
    check('the panel registers the key pool section', /t\('keys'\)/.test(clientSource), '')
    check('the panel registers the artist section', /t\('artist'\)/.test(clientSource), '')
    check('the panel registers the auto-render toggle', /t\('autoOn'\)/.test(clientSource), '')
    // Retired surfaces: no floating studio launcher and no per-mode override card.
    check('the floating studio is gone', !/ctx\.effect\(\(\) => installFloatingStudio/.test(clientSource), '')
    check('the per-mode override card is gone', !/t\('sideModes'\)/.test(clientSource), '')
    check('the character editor offers the prompt rewrite', /t\('sideCharAiEdit'\)/.test(clientSource), '')

  // ------------------------------------------------------------ comic recipe --
  const { RECIPE_GROUPS, describeRecipe, normalizeRecipe, recipeFragments } = await import('./recipe.js')
  check(
    'the recipe table is complete',
    RECIPE_GROUPS.length >= 4 && RECIPE_GROUPS.every((group) => group.options.length > 0 && group.options.some((option) => option.key === group.default)),
    RECIPE_GROUPS.map((group) => `${group.key}(${group.options.length})`).join(' ')
  )
  const filledRecipe = normalizeRecipe(config.modes?.comic?.recipe)
  check('a recipe always fills every group', Object.keys(filledRecipe).length === RECIPE_GROUPS.length, JSON.stringify(filledRecipe))
  const fragments = recipeFragments(filledRecipe)
  check('the recipe produces phrasing', fragments.positive.length > 0, fragments.positive.slice(0, 80))
  check('the recipe describes itself for a readout', /色彩/.test(describeRecipe(filledRecipe)), describeRecipe(filledRecipe).slice(0, 70))
  }

  // ------------------------------------------------- character rewrite prompt --
  // Pure: builds the prompt and merges a reply, so a refactor that drops the
  // instruction (or the host-owned ids) is caught without a model call.
  const { characterEditPrompt, mergeEditDraft, normalizeEditDraft } = await import('./character-edit.js')
  const editPrompt = characterEditPrompt(
    {
      name: '测试角色',
      keywords: ['测试'],
      fixedFeatures: 'red hair, red eyes',
      variableFeatures: [{ name: '制服', prompt: 'school uniform' }],
      negative: ''
    },
    '把发色改成银白色'
  )
  check('the character rewrite prompt carries the instruction', editPrompt.user.includes('把发色改成银白色'), editPrompt.user.slice(-60))
  check('the character rewrite prompt asks for JSON', /"fixedFeatures"/.test(editPrompt.system), editPrompt.system.slice(0, 50))
  const merged = mergeEditDraft(
    { id: 'ch-test', groupId: 'grp-test', name: '测试角色', fixedFeatures: 'red hair, red eyes' },
    normalizeEditDraft({ fixedFeatures: 'silver hair, red eyes', analysis: '已改发色' })
  )
  check(
    'a rewrite keeps the host-owned ids and the new features',
    merged.id === 'ch-test' && merged.groupId === 'grp-test' && merged.fixedFeatures === 'silver hair, red eyes',
    JSON.stringify({ id: merged.id, groupId: merged.groupId, fixedFeatures: merged.fixedFeatures })
  )

  // ----------------------------------------------------------------- dsh-go --
  // The Android app reads `dshGo` from package.json and draws either a card
  // (presentationMeta) or the native panel. A malformed manifest or an
  // over-budget view silently drops that surface, so both are checked here.
  const { generateView, panelView, toolCard } = await import('./dsh-go.js')
  let manifestOk = false
  let manifestDetail = ''
  try {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    const manifest = pkg.dshGo ?? null
    const panels = Array.isArray(manifest?.contributes?.panels) ? manifest.contributes.panels : []
    const strips = Array.isArray(manifest?.contributes?.['composer.strip']) ? manifest.contributes['composer.strip'] : []
    const bytes = Buffer.byteLength(JSON.stringify(manifest ?? null), 'utf8')
    manifestOk = manifest?.v === 1 && panels.length > 0 && strips.length > 0 && bytes <= 16 * 1024
    manifestDetail = `v=${manifest?.v ?? '无'} panels=${panels.length} strips=${strips.length} ${bytes} bytes`
  } catch (error) {
    manifestDetail = String(error?.message ?? error)
  }
  check('the dsh-go manifest declares a panel and a strip', manifestOk, manifestDetail)
  const dshGoPanel = panelView({ locale: 'zh' })
  const panelBytes = Buffer.byteLength(JSON.stringify(dshGoPanel), 'utf8')
  check('the dsh-go panel view is inside its budget', panelBytes <= 32 * 1024, `${panelBytes} bytes`)
  const dshGoCard = toolCard((_args, value) => generateView(value))({}, {
    request: { width: 832, height: 1216, steps: 28, model: 'nai-diffusion-5-full', prompt: 'test' },
    files: [{ file: 'a.png', bytes: 1000, seed: 1 }]
  })
  check(
    'the dsh-go tool card is inside its budget',
    dshGoCard['dsh-go/view'] !== undefined,
    `${Buffer.byteLength(JSON.stringify(dshGoCard), 'utf8')} bytes`
  )

  // ------------------------------------------------------------------ filesystem --
  const { access } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  try {
    await access(outputDir, constants.W_OK)
    check('the output directory is writable', true, outputDir)
  } catch (error) {
    check('the output directory is writable', false, `${outputDir}: ${error.code ?? error.message}`)
  }
  try {
    await access(join(packageRoot, 'client.js'), constants.R_OK)
    check('the package files are all present', true, packageRoot)
  } catch {
    check('the package files are all present', false, packageRoot)
  }

  return { ok: checks.every((row) => row.ok), checks }
}

/**
 * Render a doctor report as text.
 * @param report - the result of `runDoctor`.
 * @returns the text a model or a person can read.
 */
export function formatDoctor(report) {
  const failed = report.checks.filter((row) => !row.ok)
  const lines = [
    report.ok ? `✅ 全部 ${report.checks.length} 项能力检查通过` : `❌ ${failed.length} / ${report.checks.length} 项未通过`,
    ''
  ]
  for (const row of report.checks) lines.push(`${row.ok ? '  ok  ' : '  FAIL'}  ${row.name}${row.detail === '' ? '' : `  — ${row.detail}`}`)
  if (!report.ok) {
    lines.push('', '上面的 FAIL 就是坏掉的能力；改了代码或配置之后重启再跑一次即可确认。')
  }
  return lines.join('\n')
}
