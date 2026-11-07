import { MODEL_OPTIONS } from './models.js'

/**
 * dsh-nai-imagegen — DSH Go (Android) native surface.
 *
 * The DSH Go app draws plugin content with its own widgets instead of running
 * the web client: tool results can carry a native card, and (on a host that has
 * the dsh-go bridge) a plugin can add a composer status strip and a real panel.
 * This module is the pure half of that: it builds plain JSON views, with no I/O,
 * so the same functions run in `presentationMeta`, in the panel view callback,
 * and in the offline test suite.
 *
 * Contract sources (dsh-go repo): `docs/plugins/quickstart.md`,
 * `docs/plugins/components.md`, `docs/plugins/inputs.md`,
 * `docs/plugins/actions.md`, `docs/plugins/slots.md` and the two
 * `docs/design/native-plugins-*.md` specs. The budgets enforced there are the
 * reason every builder here is small and every string is clipped:
 *
 *   - tool card: 8 KiB JSON, 40 nodes, depth 6
 *   - panel: 32 KiB JSON, 120 nodes, depth 8
 *   - strip: 2 KiB, 8 nodes, depth 3
 *
 * The tool cards, the status strip and the `novelai` panel stick to v1
 * components: `stack`, `row`, `text`, `callout`, `metric`, `keyValue`, `list`
 * and `actions` exist in every App version that understands plugin views, so
 * an older phone still renders them. The `novelai-studio` workbench needs real
 * inputs, which is a v2 feature; `studioView` therefore returns a v1 summary
 * when `caps.components` does not advertise `form` / `textField` / `stepper`.
 *
 * (Everything below was written for the v1 budget rules; the studio view is
 * built inside the same panel budget.) The original note follows:
 *
 * v1 components only, deliberately: `stack`, `row`, `text`, `callout`,
 * `step`-free metrics, `keyValue`, `list` and `actions` exist in every App
 * version that understands plugin views, so an older phone still renders the
 * card instead of a row of "unknown component" placeholders.
 */

/** Tool-card byte ceiling (the card is written into the conversation log). */
export const TOOL_CARD_MAX_BYTES = 8 * 1024
/** Panel view byte ceiling. */
export const PANEL_MAX_BYTES = 32 * 1024
/** Strip text ceiling, in characters. */
export const STRIP_MAX_CHARS = 24

/**
 * Wrap a view builder for `presentationMeta`, like `toolCard()` in
 * `@dsh-go/plugin-kit`.
 *
 * DSH fails a whole tool call when `presentationMeta` throws or returns a value
 * that is not lossless JSON (undefined, NaN, Infinity, -0, Date, Map), so this
 * catches, round-trips through JSON and refuses anything past the card budget.
 * A missing card is always better than a failed tool call.
 *
 * @param build - `(args, value) => view`; must be pure.
 * @param maxBytes - the ceiling, in UTF-8 bytes.
 * @returns a `presentationMeta` function.
 */
export function toolCard(build, maxBytes = TOOL_CARD_MAX_BYTES) {
  return (args, value) => {
    try {
      const view = build(args, value)
      if (view === null || view === undefined) return {}
      const text = JSON.stringify(view)
      if (text === undefined || Buffer.byteLength(text, 'utf8') > maxBytes) return {}
      return { 'dsh-go/view': JSON.parse(text) }
    } catch {
      return {}
    }
  }
}

/**
 * Clip a string for a card, keeping the head and adding an ellipsis.
 * @param text - the string.
 * @param max - the ceiling in characters.
 * @returns the clipped string.
 */
function clip(text, max) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`
}

/**
 * A locale-aware label lookup for one message pair.
 * @param caps - the panel/strip capabilities, possibly absent.
 * @returns a `(zh, en) => string` function.
 */
export function pickLocale(caps) {
  const locale = String(caps?.locale ?? 'zh').toLowerCase()
  return (zh, en) => (locale.startsWith('zh') ? zh : en)
}

// ------------------------------------------------------------- tool cards --

/**
 * Card for `nai_generate`.
 *
 * The tool returns `{ text, files, request, weight, artist, block, … }`; the
 * model still reads `text`, the phone draws this.
 *
 * @param value - the tool's return value.
 * @returns a v1 view.
 */
export function generateView(value) {
  const request = value?.request ?? {}
  const files = Array.isArray(value?.files) ? value.files : []
  const first = files[0] ?? {}
  const width = request.width ?? '?'
  const height = request.height ?? '?'
  const title = `出图 ${files.length} 张 · ${width}×${height} · ${request.steps ?? '?'} 步`
  const metrics = [
    { type: 'metric', label: '尺寸', value: `${width}×${height}` },
    { type: 'metric', label: '步数', value: String(request.steps ?? '—') },
    { type: 'metric', label: '相对消耗', value: String(value?.weight ?? '—') }
  ]
  const details = [
    ['模型', String(request.model ?? '—')],
    ['采样器', String(request.sampler ?? '—')],
    ['引导', String(request.scale ?? '—')]
  ]
  if (value?.artist !== null && value?.artist !== undefined) details.push(['画师串', String(value.artist)])
  if (first.seed !== null && first.seed !== undefined) details.push(['Seed', String(first.seed)])
  if (typeof value?.logId === 'string' && value.logId !== '') details.push(['logId', value.logId])
  const children = [
    { type: 'row', children: metrics },
    { type: 'keyValue', items: details },
    { type: 'text', text: clip(request.prompt, 360), tone: 'muted' }
  ]
  if (files.length > 0) {
    children.push({ type: 'list', items: files.slice(0, 8).map((file) => ({ title: String(file.file ?? ''), subtitle: `${file.bytes ?? 0} 字节`, trailing: file.seed === null || file.seed === undefined ? undefined : `seed ${file.seed}` })) })
  }
  const notes = Array.isArray(value?.block?.notes) ? value.block.notes : []
  if (notes.length > 0) children.push({ type: 'callout', text: clip(notes.join('；'), 200), tone: 'warn' })
  return { type: 'stack', title, children }
}

/**
 * Card for `nai_estimate`: the cost weight and whether it stays free.
 * @param value - `{ width, height, steps, nSamples, weight, perImage, free }`.
 * @returns a v1 view.
 */
export function estimateView(value) {
  const free = value?.free === true
  return {
    type: 'stack',
    title: `${value?.width ?? '?'}×${value?.height ?? '?'} · ${value?.steps ?? '?'} 步 · ${value?.nSamples ?? '?'} 张`,
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: '单张', value: String(value?.perImage ?? '—') },
          { type: 'metric', label: '合计', value: String(value?.weight ?? '—') }
        ]
      },
      { type: 'callout', text: free ? '落在 Opus 免计费区间，预期 0 Anlas' : '超出免费区间，会消耗 Anlas', tone: free ? 'good' : 'warn' },
      { type: 'text', text: '参照：832×1216 @28 步 = 1', tone: 'muted' }
    ]
  }
}

/**
 * Card for `nai_probe`: reachability plus the free subscription read.
 * @param value - `{ ok, detail, status, origin, subscription, pool, hint }`.
 * @returns a v1 view.
 */
export function probeView(value) {
  const ok = value?.ok === true
  const sub = value?.subscription ?? null
  const children = []
  if (sub !== null) {
    const anlas = sub.anlas ?? {}
    const energy = sub.energy ?? null
    children.push({
      type: 'row',
      children: [
        { type: 'metric', label: 'Anlas', value: Number.isFinite(Number(anlas.total)) ? Number(anlas.total).toLocaleString('en-US') : '—', caption: `订阅 ${Number(anlas.fixed ?? 0).toLocaleString('en-US')} · 购买 ${Number(anlas.purchased ?? 0).toLocaleString('en-US')}` },
        { type: 'metric', label: '电量', value: energy === null || energy === undefined ? '—' : `${energy}%` }
      ]
    })
    const details = [['订阅档', String(sub.tier ?? '—')], ['激活', sub.active === true ? '是' : sub.active === false ? '否' : '—']]
    if (value?.origin) details.push(['主机', String(value.origin)])
    if (value?.status !== undefined && value?.status !== null) details.push(['HTTP', String(value.status)])
    children.push({ type: 'keyValue', items: details })
  }
  children.push({ type: 'callout', text: clip(value?.detail ?? '', 240), tone: ok ? 'good' : 'bad' })
  if (value?.hint) children.push({ type: 'text', text: clip(value.hint, 240), tone: 'muted' })
  return { type: 'stack', title: ok ? '连接正常' : '连接失败', children }
}

// ------------------------------------------------------------------ panel --

/** Bilingual panel copy. */
const PANEL_TEXT = {
  zh: {
    balance: '余额',
    energy: '电量',
    model: '模型',
    size: '默认尺寸',
    artist: '画师串',
    checked: '余额更新',
    characters: '角色库（点一下把关键字放进输入框）',
    recent: '最近作品',
    refresh: '刷新余额',
    emptyChars: '还没有角色',
    emptyRecent: '还没有作品',
    notChecked: '未检测'
  },
  en: {
    balance: 'Anlas',
    energy: 'Energy',
    model: 'Model',
    size: 'Default size',
    artist: 'Artist string',
    checked: 'Balance updated',
    characters: 'Characters (tap to insert keywords)',
    recent: 'Recent works',
    refresh: 'Refresh balance',
    emptyChars: 'No characters yet',
    emptyRecent: 'No renders yet',
    notChecked: 'not checked'
  }
}

/**
 * The native panel view. Dynamic values are bindings into the data the host
 * pushes (`data(scope, emit, caps)`), so the view is built once per open.
 *
 * @param caps - `{ locale, … }` from the bridge, possibly absent.
 * @returns a v1 view tree within the panel budget.
 */
export function panelView(caps) {
  const t = pickLocale(caps)
  const L = PANEL_TEXT[String(caps?.locale ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en']
  return {
    type: 'stack',
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: L.balance, value: { $: 'data.balance.totalText' }, caption: { $: 'data.balance.breakdown' } },
          { type: 'metric', label: L.energy, value: { $: 'data.balance.energyText' }, caption: t('V5 电量', 'V5 energy') }
        ]
      },
      {
        type: 'keyValue',
        items: [
          [L.model, { $: 'data.model' }],
          [L.size, { $: 'data.size' }],
          [L.artist, { $: 'data.artistText' }],
          [L.checked, { $: 'data.checkedText' }]
        ]
      },
      { type: 'actions', items: [{ label: L.refresh, action: 'refresh', icon: 'refresh', style: 'primary' }] },
      { type: 'text', text: L.characters, tone: 'muted' },
      { type: 'list', items: { $: 'data.characterItems' } },
      { type: 'text', text: L.recent, tone: 'muted' },
      { type: 'list', items: { $: 'data.recentItems' } }
    ]
  }
}

/**
 * Composer strip content: one short line, ≤ 24 characters.
 *
 * @param data - the cached panel data, or `null` before the first probe.
 * @param caps - `{ locale }`, possibly absent.
 * @returns `{ text, icon, tone }`.
 */
export function stripText(data, caps) {
  if (data?.balance?.totalText) {
    const percent = data.balance.energyText && data.balance.energyText !== '—' ? `⚡${data.balance.energyText} · ` : ''
    return { text: clip(`${percent}${data.balance.totalText} Anlas`, STRIP_MAX_CHARS), icon: 'coin', tone: data.balance.tone ?? 'info' }
  }
  return { text: pickLocale(caps)('NAI · 未检测', 'NAI · not checked'), icon: 'coin', tone: 'muted' }
}

/**
 * Build the item arrays the panel's `list` bindings read, so the host only has
 * to push plain JSON.
 *
 * @param characters - `[{ id, name, group, keywords, insertText }]`.
 * @param recent - `[{ name, bytes, when, path }]`.
 * @returns `{ characterItems, recentItems }`.
 */
export function listItems(characters, recent) {
  return {
    characterItems: (Array.isArray(characters) ? characters : []).slice(0, 20).map((row) => ({
      title: String(row.name ?? ''),
      subtitle: clip([row.group, (row.keywords ?? []).slice(0, 4).join(', ')].filter(Boolean).join(' · '), 120),
      trailing: '＋',
      action: { id: 'useCharacter', args: { id: String(row.id ?? '') } }
    })),
    recentItems: (Array.isArray(recent) ? recent : []).slice(0, 10).map((row) => ({
      title: String(row.name ?? ''),
      subtitle: clip(`${formatBytes(row.bytes)} · ${row.when ?? ''}`, 80),
      action: { id: 'copyFile', args: { path: String(row.path ?? '') } }
    }))
  }
}

/**
 * Human byte size for the recent list.
 * @param bytes - the size.
 * @returns `"1.6 MB"` style text.
 */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}


// ------------------------------------------------------------------ studio --

/** Sizes offered by the studio panel (both axes are multiples of 64). */
export const STUDIO_SIZES = Object.freeze([
  { label: '832 × 1216', value: '832x1216' },
  { label: '1216 × 832', value: '1216x832' },
  { label: '1024 × 1024', value: '1024x1024' },
  { label: '1344 × 768', value: '1344x768' }
])

/** Text-to-image models offered by the studio panel. */
export const STUDIO_MODELS = Object.freeze(
  MODEL_OPTIONS.filter((model) => model.inpaint !== true).map((model) => ({ label: model.label, value: model.id }))
)

/** Samplers offered by the studio panel. */
export const STUDIO_SAMPLERS = Object.freeze(
  ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde', 'ddim_v3'].map((value) => ({ label: value, value }))
)

/**
 * The native generation workbench: a real form, not a summary.
 *
 * The form's submit starts a render in the host (an action cannot wait for a
 * render, so the panel is fed progress through `data` instead), and each field
 * mirrors its value into the host with `onChange: 'changed'` so the periodic
 * data pushes never overwrite what the user is typing.
 *
 * @param caps - `{ locale }` from the bridge, possibly absent.
 * @returns a v2 view tree within the panel budget.
 */
export function studioView(caps) {
  const t = pickLocale(caps)
  // Inputs are v2-only. An App whose caps.components predates them would draw a
  // grey placeholder for every field, so it gets a v1 summary instead; missing
  // caps follow the docs and count as v1.
  const components = Array.isArray(caps?.components) ? caps.components : null
  const supportsForm =
    components !== null && components.includes('form') && components.includes('textField') && components.includes('stepper')
  if (!supportsForm) {
    return {
      v: 1,
      type: 'stack',
      children: [
        {
          type: 'callout',
          text: t(
            '当前 DSH Go 版本不支持生图工作台表单，请升级 App 后再用。',
            'This DSH Go version cannot draw the studio form; update the app to use it.'
          )
        },
        {
          type: 'text',
          text: t(
            '旧版本仍可在对话里让 Agent 调用 nai_generate 出图。',
            'On older versions you can still render through nai_generate in chat.'
          ),
          tone: 'muted'
        }
      ]
    }
  }
  /** One form field; every editable field mirrors its value into the host. */
  const field = (node) => ({ onChange: 'changed', ...node })
  return {
    v: 2,
    type: 'stack',
    children: [
      {
        type: 'form',
        submit: 'generate',
        submitLabel: t('生成', 'Generate'),
        children: [
          field({
            type: 'textField',
            label: t('提示词', 'Prompt'),
            bind: 'data.form.prompt',
            multiline: true,
            maxLines: 6,
            required: true,
            placeholder: t('1girl, solo, 街道, 黄昏…', '1girl, solo, street, dusk…')
          }),
          field({
            type: 'textField',
            label: t('负面提示词', 'Negative prompt'),
            bind: 'data.form.negative',
            multiline: true,
            maxLines: 3,
            placeholder: t('留空使用默认', 'blank = default')
          }),
          field({
            type: 'segmented',
            label: t('尺寸', 'Size'),
            bind: 'data.form.size',
            options: STUDIO_SIZES.map((row) => ({ label: row.label, value: row.value }))
          }),
          field({
            type: 'select',
            label: t('模型', 'Model'),
            bind: 'data.form.model',
            options: STUDIO_MODELS.map((row) => ({ label: row.label, value: row.value }))
          }),
          field({
            type: 'select',
            label: t('采样器', 'Sampler'),
            bind: 'data.form.sampler',
            options: STUDIO_SAMPLERS.map((row) => ({ label: row.label, value: row.value }))
          }),
          field({ type: 'stepper', label: t('步数', 'Steps'), bind: 'data.form.steps', min: 1, max: 50 }),
          field({ type: 'stepper', label: t('张数', 'Samples'), bind: 'data.form.n', min: 1, max: 4 }),
          field({
            type: 'number',
            label: t('种子（留空随机）', 'Seed (blank = random)'),
            bind: 'data.form.seed',
            min: 0,
            max: 4294967295
          }),
          field({
            type: 'toggle',
            label: t('使用当前画师串', 'Use current artist string'),
            bind: 'data.form.useArtist'
          })
        ]
      },
      // 「AI 写词」: the same writer the web panel has, reachable from the phone.
      // One sentence becomes a structured caption written back into the form.
      {
        type: 'textField',
        label: t('AI 写词：一句话描述画面', 'AI prompt: describe the scene'),
        bind: 'data.writer.text',
        multiline: true,
        maxLines: 4,
        placeholder: t('例：雨后的屋顶，少女坐着看远处的城市', 'e.g. a girl on a rooftop after rain, city in the distance'),
        onChange: 'changed'
      },
      {
        type: 'actions',
        items: [
          { label: t('AI 写词', 'Write'), action: 'write', icon: 'lightbulb' },
          { label: t('取消写词', 'Cancel writing'), action: 'cancelWrite', icon: 'stop' }
        ]
      },
      { type: 'text', text: { $: 'data.writerText' }, tone: 'muted' },
      { type: 'text', text: { $: 'data.writerError' }, tone: 'bad' },
      { type: 'text', text: { $: 'data.estimateText' }, tone: 'muted' },
      { type: 'callout', text: { $: 'data.jobText' } },
      { type: 'actions', items: [{ label: t('取消生成', 'Cancel'), action: 'cancel', icon: 'stop' }] },
      { type: 'text', text: { $: 'data.resultText' }, tone: 'muted' },
      { type: 'list', items: { $: 'data.resultItems' } },
      {
        type: 'text',
        text: t(
          '图片保存在输出目录；用 DSH Go 的网页模式或文件管理器查看。',
          'Images land in the output folder; open DSH Go web mode or a file manager to view them.'
        ),
        tone: 'muted'
      }
    ]
  }
}
