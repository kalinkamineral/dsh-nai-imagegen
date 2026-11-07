/**
 * dsh-nai-imagegen — configuration.
 *
 * One JSON document under `$DSH_HOME/nai-imagegen/config.json`, written through
 * a temp file so a crash cannot leave a half-written document behind. The
 * token may also arrive from the `NAI_TOKEN` environment variable, which wins
 * over the file so a shell export can override a stale stored value without
 * editing anything.
 *
 * Nothing in this module talks to the network.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Profile row id; also the state directory name under DSH home. */
export const ROW_ID = 'nai-imagegen'
/** DSH home: the desktop app sets DSH_HOME; the fallback matches the runtime. */
export const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** This plugin's state directory. */
export const STATE_DIR = join(HOME, ROW_ID)
/** The configuration document. */
export const CONFIG_FILE = join(STATE_DIR, 'config.json')

/** The five attachment libraries this plugin can search, in lookup order. */
export const LIBRARIES = ['标签库9.5', '常规模板5.25', '扩展库5.4', '同人库8.5', 'SEX模板9.2']

/** The two render modes. `auto` picks one of these per input. */
export const MODE_NAMES = ['illustration', 'comic']

/**
 * The fields a mode may override, with the type each must end up as.
 *
 * Declared once so the normaliser, the host's resolution and the panel all agree
 * on the same set — a new override added in one place would otherwise be silently
 * dropped by the other two.
 */
export const MODE_FIELDS = {
  artistId: 'number',
  width: 'number',
  height: 'number',
  steps: 'number',
  scale: 'number',
  ucPreset: 'number',
  maxImagesPerCall: 'number',
  model: 'string',
  sampler: 'string',
  negativePrompt: 'string',
  /**
   * 官方质量词开关（Quality Tags）。**默认关**，需要时手动打开。
   *
   * 开启后把官方那段 `very aesthetic, masterpiece, no text` 追加到正向末尾
   * （正文见 lib/quality-tags.js）。默认关的理由：本项目的风格词来自画师串，
   * 而画师串常自带 `masterpiece, best quality, very aesthetic`，开了会重复叠加。
   */
  qualityToggle: 'boolean',
  /**
   * 头部插入：一段会被放到正向**最前面**的文字，位置在画师串之前。
   *
   * 用途是 NovelAI 的「数据集切换标签」——官方文档规定 `fur dataset,`（Furry Mode）
   * 与 `background dataset,` 必须位于提示词最开头才生效，而画师串固定占住第一位，
   * 所以这类前导标签只能由本插件主动前置。设计成自由字符串而不是布尔开关，
   * 是为了以后 NovelAI 再出同类机制时不必改代码。
   */
  header: 'string'
}

/**
 * Shipped defaults. `outputDir` and `libraryDir` are intentionally relative-ish
 * placeholders the first `nai_status` call reports so the panel can point the
 * user at them; neither is created until an image is actually written.
 */
export function defaults() {
  return {
    baseUrl: 'https://image.novelai.net',
    token: '',
    /**
     * The current model id. V5 is what the accompanying libraries target and
     * what the official client sends.
     *
     * Known-good ids: `nai-diffusion-5-full`, `nai-diffusion-4-5-full`,
     * `nai-diffusion-4-full`, `nai-diffusion-3`. What is established from real
     * output is the *host*, not the id: generation must go to
     * `image.novelai.net`, because the retired `api.novelai.net` rejects the
     * request with `400 model must be a valid enum value` — which reads like a
     * bad model id but is a stale host. Real PNGs on this machine carry
     * `Source: NovelAI Diffusion V4.5` and `NovelAI Diffusion V4`, so those ids
     * are live; do not treat 4.5 as invalid.
     */
    model: 'nai-diffusion-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    /** Matches the official web client's default for V5. */
    ucPreset: 3,
    /**
     * 官方质量词开关。默认关：开启会把官方那段
     * `very aesthetic, masterpiece, no text` 追加到正向末尾，而画师串里往往已有同类词，
     * 默认开会造成无意重复。正文见 lib/quality-tags.js。
     */
    qualityToggle: false,
    negativePrompt:
      'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, ' +
      'fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, ' +
      'signature, watermark, username, blurry',
    /**
     * 头部插入：放到正向最前面的文字（画师串之前）。
     *
     * 空字符串是默认值，表示不插入。典型用法是 NovelAI 的数据集切换标签，
     * 例如 `fur dataset`（Furry Mode）或 `background dataset`——这两者官方要求
     * 位于提示词最开头，而画师串会占住第一位，所以必须由插件前置。
     */
    header: '',
    /**
     * Response format asked of the relay: `json` (default), `zip` or `auto`.
     * `json` is the nai-dbgen-style base64 envelope; `zip` is the smallest
     * transfer; `auto` accepts whatever comes back.
     */
    decode: 'json',
    /**
     * 单次出图请求的总时限（毫秒）。空闲超时只能发现「连接彻底安静了」，
     * 一个每分钟滴几字节的中转永远不会触发它；5 分钟与参考插件
     * （st-chatu8 的 300 秒）一致。0 表示不限制。
     */
    requestTimeoutMs: 300000,
    /** V5 共享试用标记，官方客户端和 st-chatu8 的 V5 请求都会带；只对 v5 生效。 */
    useNewSharedTrial: true,
    /** Where generated PNGs land; the Agent embeds these paths in its reply. */
    outputDir: join(process.cwd(), '_out', 'nai'),
    /**
     * Where `nai_img2img` may read base images from.
     *
     * Deliberately a separate directory from the output gallery: the tool is
     * model-invoked, so its readable surface has to be one directory the user
     * controls, not "anywhere on disk". Empty means "derive it from the output
     * directory" — `<outputDir>/../../_in/nai`, which is stable across restarts
     * and follows wherever the user pointed `outputDir`, unlike a `process.cwd()`
     * default that depends on how DSH was launched.
     */
    sourceDir: '',
    /** Directory holding `<库名>.jsonl` indexes built by `nai_index`. */
    libraryDir: join(process.env.USERPROFILE || homedir(), 'Downloads', '文生图用', '_pyrite-extract'),
    /** Where `nai_index` reads the original world-book JSONs from. */
    librarySourceDir: join(process.env.USERPROFILE || homedir(), 'Downloads', '文生图用'),
    /** Billing guard: refuse a single call that would render more than this. */
    maxImagesPerCall: 4,
    /**
     * How to reach NovelAI.
     *
     *   `''` / `off`      — connect directly (default)
     *   `auto` / `system` — use the Windows system proxy when one is detected
     *   anything else     — used verbatim as the proxy URL
     *
     * Direct is the default because the usual setup points `baseUrl` at a relay
     * that forwards to NovelAI; a proxy is opt-in. (Blank used to mean "follow the
     * system proxy", which silently changed the route whenever a proxy app turned
     * its system switch on or off.)
     */
    proxy: '',
    /**
     * Additional API keys, each `{ label, token, enabled }`.
     *
     * The pool dispatches one request per usable key, so four keys render four
     * images at once. The single `token` above stays supported and becomes the
     * first key, so an existing config keeps working.
     */
    keys: [],
    /** Where the artist index lives; written by `import-artists.mjs`. */
    artistIndex: join(STATE_DIR, 'artists', 'index.json'),
    /** Optional override for the archive path recorded inside the index. */
    artistSource: '',
    /**
     * Which artist string is in force, as an index into the artist archive.
     * `-1` means none.
     *
     * A number rather than a nullable id on purpose: `normalize` coerces by
     * `typeof`, and `typeof null` is `'object'`, which would turn a null into the
     * string `"null"`.
     */
    artistId: -1,
    /**
     * Which page formats the render path accepts.
     *
     *   `auto`         — recognise each input on its own (default): a
     *                    `nai5-comic` page, an `<image>` block, or a plain prompt
     *   `comic`        — read a comic page first
     *   `illustration` — never read a comic page; only the 插画 formats
     *
     * `auto` keeps both working without the user having to remember which mode
     * they are in; the explicit values let either be forced, and neither path
     * touches the other's parameters.
     */
    mode: 'auto',
    /**
     * Per-mode overrides for the settings that differ between 出图 and 漫画.
     *
     * Each entry may carry `artistId`, `width`, `height`, `steps`, `model`,
     * `sampler`, `scale`, `ucPreset`, `negativePrompt` and `maxImagesPerCall`.
     * Anything absent falls back to the value above, so the shared defaults keep
     * working and only the differences have to be stated.
     *
     * The style matters most: a comic page and a single illustration rarely want
     * the same artist string, and sharing one meant every comic page silently
     * carried the illustration's style. `mode: 'auto'` decides which set applies
     * per render by which format the input turns out to be.
     */
    modes: { illustration: {}, comic: {} },
    /**
     * Render prompt code blocks in the transcript automatically instead of
     * waiting for a click. Off by default: it spends quota without being asked.
     */
    autoGenerate: false,
    /**
     * Inject the「🎨 生图」button under prompt-looking code blocks, and with it the
     * MutationObserver that rescans the transcript on every DOM change. Off by
     * default: the observer is the plugin's only continuously-running work and it
     * scales with the transcript, so it should be opt-in.
     */
    codeButtons: false,
    /** Keep the newest N images on disk; `0` disables trimming. */
    keepImages: 500,
    /**
     * The language model for prompt writing and reference-image analysis.
     * Both empty means "the model DSH's agent uses" (`agentDefaultModel`); set
     * both to pin another route the user configured in DSH.
     */
    llmProvider: '',
    llmModel: '',
    /** Output cap for one prompt-writing call. */
    llmMaxTokens: 4096,
    /**
     * How many times the prompt writer may ask again after a reply that does
     * not follow the field grammar (0..5). Each retry is one more model call.
     */
    writerRetries: 2,
    /** CFG rescale, 0..1. 0 is the official client's default. */
    cfgRescale: 0,
    /**
     * Noise schedule: karras / native / exponential / polyexponential. V5 only
     * accepts karras, so lib/nai.js forces it there whatever is stored.
     */
    noiseSchedule: 'karras',
    /**
     * "Variety": skip guidance at high sigma, which NovelAI exposes for the 4.5
     * models only. Off by default, like the official client.
     */
    variety: false,
    /**
     * 透明底: V5 renders with an alpha channel. Off by default, as in the official
     * client. Applies to V5 only; lib/nai.js and renderNow ignore it elsewhere.
     */
    transparentBackground: false,
    /** SMEA for V3: 'off' | 'smea' | 'smea_dyn'. V4 and later do not have it. */
    smea: 'off',
    /**
     * How long a render may spend *connecting* to NovelAI (DNS, TCP, the proxy's
     * CONNECT, the TLS handshake) before it fails with NAI_UNREACHABLE, 2–60 s.
     * The render itself then has its own, much longer idle timeout. Without this
     * a blackholed route hung every render for minutes.
     */
    connectTimeoutMs: 12000
  }
}

/** The noise schedules NovelAI accepts. */
export const NOISE_SCHEDULES = ['karras', 'native', 'exponential', 'polyexponential']

/**
 * Pull the few range-limited fields back into their range after coercion. Kept
 * apart from `normalize`'s type pass, which only knows types.
 * @param config - a type-normalised configuration.
 * @returns the same object.
 */
function clampRanges(config) {
  config.writerRetries = Math.min(5, Math.max(0, Math.round(config.writerRetries)))
  config.cfgRescale = Math.min(1, Math.max(0, config.cfgRescale))
  if (!NOISE_SCHEDULES.includes(config.noiseSchedule)) config.noiseSchedule = 'karras'
  if (!['off', 'smea', 'smea_dyn'].includes(config.smea)) config.smea = 'off'
  config.connectTimeoutMs = Math.min(60000, Math.max(2000, Math.round(config.connectTimeoutMs)))
  return config
}

/** Cached document; `null` until the first read. */
let cache = null

/**
 * Coerce one loaded document over the shipped defaults, so a config written by
 * an older version still produces a complete object.
 * @param raw - whatever was on disk.
 * @returns a complete configuration.
 */
function normalize(raw) {
  const base = defaults()
  if (raw === null || typeof raw !== 'object') return base
  const out = { ...base }
  for (const key of Object.keys(base)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    // Arrays must be handled before the string branch: `typeof []` is 'object',
    // so a naive coercion would turn the key list into "[object Object],…".
    if (Array.isArray(base[key])) {
      if (!Array.isArray(value)) continue
      out[key] = value
        .map((entry) => {
          if (typeof entry === 'string') return { label: '', token: entry.trim(), enabled: true }
          if (entry === null || typeof entry !== 'object') return null
          const token = String(entry.token ?? '').trim()
          if (token === '') return null
          const row = { label: String(entry.label ?? ''), token, enabled: entry.enabled !== false }
          // The id has to survive normalisation. Dropping it here (this branch
          // used to rebuild entries as label/token/enabled only) means every
          // `save` hands the panel a fresh id, so an enable, disable or remove
          // addresses a key that no longer exists and silently does nothing.
          if (typeof entry.id === 'string' && entry.id !== '') row.id = entry.id
          return row
        })
        .filter((entry) => entry !== null)
      continue
    }
    // A plain object of settings — the per-mode overrides. Handled before the
    // string branch for the same reason arrays are: `typeof {}` is 'object', and
    // `String({})` would turn the whole block into "[object Object]".
    if (base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const clean = {}
      for (const [mode, overrides] of Object.entries(value)) {
        if (!MODE_NAMES.includes(mode) || overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) continue
        const row = {}
        for (const [field, kind] of Object.entries(MODE_FIELDS)) {
          const incoming = overrides[field]
          if (incoming === undefined || incoming === null) continue
          if (kind === 'number') {
            const n = Number(incoming)
            if (Number.isFinite(n)) row[field] = n
            continue
          }
          if (kind === 'boolean') {
            // Booleans need their own branch here for the same reason the top-level
            // normaliser needs one: `String(true)` is `"true"`, and every downstream
            // check is a strict `=== true`, so a mode override would read as off no
            // matter what the panel saved. The panel sends real booleans now, but old
            // saved JSON and hand-edited files may carry `"true"` / `1`.
            row[field] = incoming === true || incoming === 'true' || incoming === 1 || incoming === '1'
            continue
          }
          row[field] = String(incoming)
        }
        // The comic recipe is a nested map of group → option key. Copied as plain
        // strings; which options are real is decided by the recipe table at use
        // time, so a stale key is ignored rather than crashing a load.
        const recipe = overrides.recipe
        if (recipe !== null && typeof recipe === 'object' && !Array.isArray(recipe)) {
          const kept = {}
          for (const [group, value] of Object.entries(recipe)) {
            if (typeof value === 'string' && value !== '') kept[group] = value
          }
          if (Object.keys(kept).length > 0) row.recipe = kept
        }
        clean[mode] = row
      }
      out[key] = clean
      continue
    }
    if (typeof base[key] === 'number') {
      const n = Number(value)
      if (Number.isFinite(n)) out[key] = n
      continue
    }
    // Booleans need their own branch. Falling through to `String(value)` turns
    // `true` into `"true"`, and every downstream check is a strict `=== true`,
    // so the setting would read as off no matter what the panel saved.
    if (typeof base[key] === 'boolean') {
      out[key] = value === true || value === 'true' || value === 1 || value === '1'
      continue
    }
    out[key] = String(value)
  }
  // `decode` is an enum, not free text: a hand-edited or stale value falls back
  // to the default instead of reaching `acceptForDecode` as an unknown string.
  if (!['json', 'zip', 'auto'].includes(out.decode)) out.decode = 'json'
  return clampRanges(out)
}

/**
 * Read the configuration once per process.
 * @returns the effective configuration.
 */
export async function load() {
  if (cache !== null) return cache
  try {
    // Notepad and PowerShell's `Out-File -Encoding utf8` write a byte-order mark.
    // JSON.parse rejects it, and falling back to the defaults here silently dropped
    // the token and every setting — and the next save wrote those defaults back.
    cache = normalize(JSON.parse((await readFile(CONFIG_FILE, 'utf8')).replace(/^\uFEFF/, '')))
  } catch {
    cache = defaults()
  }
  return cache
}

/**
 * Merge a partial update into the configuration and persist it.
 * @param patch - fields to replace; unknown keys are ignored.
 * @returns the stored configuration.
 */
export async function save(patch) {
  const current = await load()
  const next = normalize({ ...current, ...(patch ?? {}) })
  cache = next
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  const temp = `${CONFIG_FILE}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, CONFIG_FILE)
  return next
}

/**
 * The token actually in force: environment first, then the stored value.
 * @param config - an already loaded configuration, if the caller has one.
 * @returns the bearer token, or an empty string.
 */
export async function tokenOf(config) {
  const env = (process.env.NAI_TOKEN || '').trim()
  if (env) return env
  const held = config ?? (await load())
  return String(held.token || '').trim()
}

/**
 * Resolve the output directory to an absolute path.
 * @param config - an already loaded configuration, if the caller has one.
 * @returns the absolute output directory.
 */
export async function outputDirOf(config) {
  const held = config ?? (await load())
  return resolve(held.outputDir)
}

/**
 * Resolve the base-image source directory to an absolute path.
 *
 * An explicit `sourceDir` wins. When it is empty the default is derived from the
 * output directory — the output gallery sits at `<root>/_out/nai`, so the source
 * folder is `<root>/_in/nai`. Deriving it keeps one absolute path in the config
 * from deciding two directories, and avoids a default that silently changes with
 * the process's working directory.
 *
 * @param config - an already loaded configuration, if the caller has one.
 * @returns the absolute source directory.
 */
export async function sourceDirOf(config) {
  const held = config ?? (await load())
  const configured = String(held.sourceDir ?? '').trim()
  if (configured !== '') return resolve(configured)
  return resolve(dirname(resolve(held.outputDir)), '..', '_in', 'nai')
}
