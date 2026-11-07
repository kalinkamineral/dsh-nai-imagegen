/**
 * dsh-nai-imagegen — 官方 Undesired Content 预设正文。
 *
 * 为什么需要这个文件
 * ------------------
 * NovelAI 的 `ucPreset` 请求字段**只是元数据**：它会被写进图片 metadata，供网页端
 * 导入时还原下拉框选了哪一档，但**服务器并不据它拼接任何文本**。
 *
 * 证据链（注意每条的**强度不同**，不要一概当成官方规范）：
 *   1. 【官方·确定】官方文档 <https://docs.novelai.net/en/image/undesiredcontent>
 *      逐条列出了每个预设的**正文**，并说预设可以「与你自己的 undesired tags 组合」
 *      —— 即正文属于提示词，不是服务端开关。本文件的正文即以此为准。
 *   2. 【第三方·强旁证】两个独立开源参考插件都把正文**拼进 `negative_prompt`** 后发送，
 *      且它们的 10 个档位（2 模型 × 5 档）经**逐字比对完全一致**：
 *      - `NovelAI-PC-Clean`（第三方）`app/backend.js` 的 `Nd` 表
 *      - `nai-dbgen`（第三方）`src/domain/nai/param-options.js` 的
 *        `OFFICIAL_UC_TEXT` + `UC_PRESET_KEYS`
 *      两者都是**第三方开源项目**，并非 NovelAI 官方发布；它们自称转录自「桌面端」，
 *      但「桌面端」具体指哪个应用、是否官方，两个仓库都没有明说，未经查证。
 *      本文件照抄其一，是因为它们与官方文档的正文**逐字吻合**。
 *      ⚠️ 「正文如何与用户负向拼接」这类细节官方文档**没有规定**，
 *      只能以参考插件为准（见 `applyUcPreset` 的注释）。
 *   3. 【本机实测】仅切换 `ucPreset`（0/1/2/3/4）而提示词逐字不变时，五张图字节极差 97 B
 *      （占单张 1.09 MB 的 0.0089%），画面无可见差异——若服务端真的据该字段拼接，
 *      从 `heavy` 到 `none` 不可能几乎同图。注意这只证明了**当前这个第三方代理端点**
 *      忽略该字段，官方端点未测。
 *
 * 模型族的差异只体现在 `light` 一档
 * ------------------------------
 *   heavy     4.5 与 5.0 相同（238 字符）
 *   light     **不同**：4.5 为 165 字符，5.0 为 133 字符（5.0 另有 sepia/white haze/ai-generated）
 *   furryFocus 两族相同（299 字符）
 *   humanFocus 两族相同（289 字符）
 *   none      两族皆为空串
 *
 * 因此同样填 `1`，V4.5 与 V5 会得到不同的负向——这个文件的存在意义就是别把两族混用。
 * 但**档位编号与分类名两版一致**（0严格排除/1轻度排除/2兽人主体/3人类主体/4不使用），
 * 所以 UI 上的档位说明对两种模型都成立。
 */
import { modelFamily } from './models.js'

/**
 * 档位名，按 `ucPreset` 的数值下标排列。
 *
 * 两个参考插件的下标一致，也与官方网页端下拉框的顺序一致：
 * `0 heavy` / `1 light` / `2 furryFocus` / `3 humanFocus` / `4 none`。
 *
 * 注意 `none` 的编号是 **4**，而本插件历史上曾把范围当 0..3（那时也就拿不到 none）。
 */
export const UC_PRESET_KEYS = Object.freeze(['heavy', 'light', 'furryFocus', 'humanFocus', 'none'])

/** `none` 档的编号；这一档不追加任何正文。 */
export const UC_PRESET_NONE = 4

/**
 * 官方预设正文，按模型族分组。
 *
 * 逐字抄自两个参考插件（二者完全一致），并与官方文档的
 * `V4.5 Full` / `V5 Full` 两节核对过。不要凭印象改写这些串：
 * 里面的 `{}` / `[]` 是 NovelAI 的权重语法，原样保留才有官方那个强度。
 *
 * @type {Readonly<Record<'v45'|'v5', Readonly<Record<string, string>>>>}
 */
export const OFFICIAL_UC_TEXT = Object.freeze({
  v45: Object.freeze({
    heavy:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, ' +
      'jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, ' +
      'multiple views, logo, too many watermarks, negative space, blank page',
    light:
      'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, ' +
      'multiple views, very displeasing, too many watermarks, negative space, blank page',
    furryFocus:
      '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, ' +
      '{sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, ' +
      'everyone, [sketch background], simple, [flat colors], ych (character), outline, ' +
      'multiple scenes, [[horror (theme)]], comic',
    humanFocus:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, ' +
      'jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, ' +
      'multiple views, logo, too many watermarks, negative space, blank page, ' +
      '@_@, mismatched pupils, glowing eyes, bad anatomy',
    none: ''
  }),
  v5: Object.freeze({
    heavy:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, ' +
      'jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, ' +
      'multiple views, logo, too many watermarks, negative space, blank page',
    light:
      'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, ' +
      'very displeasing, jpeg artifacts, 0::ai-generated::',
    furryFocus:
      '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, ' +
      '{sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, ' +
      'everyone, [sketch background], simple, [flat colors], ych (character), outline, ' +
      'multiple scenes, [[horror (theme)]], comic',
    humanFocus:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, ' +
      'jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, ' +
      'multiple views, logo, too many watermarks, negative space, blank page, ' +
      '@_@, mismatched pupils, glowing eyes, bad anatomy',
    none: ''
  })
})

/**
 * Which preset table applies to a model id.
 *
 * Only V4.5 and V5 have the five-preset set. `nai-diffusion-4-full` and
 * `nai-diffusion-3` have their own (smaller) presets in the official client, and
 * applying the 4.5 text there would inject suppression the model's own UI never
 * sends — so those report `null` rather than a guess, and the caller adds
 * nothing.
 *
 * @param model - the model id from the request.
 * @returns `'v45'`, `'v5'`, or `null` when the model has no table here.
 */
export function ucFamilyFor(model) {
  // Through lib/models.js, so curated and inpainting ids share their family's table.
  const family = modelFamily(model)
  if (family === 'v5') return 'v5'
  if (family === 'v4.5') return 'v45'
  return null
}

/**
 * The preset's text for one model and one index.
 *
 * An out-of-range or non-integer index falls back to `none` (no text) rather
 * than to `heavy`: silently injecting suppression the user did not ask for is a
 * worse failure than adding nothing, because it changes the render while looking
 * like it did not.
 *
 * @param model - the model id from the request.
 * @param index - the `ucPreset` value.
 * @returns the text to prepend to the negative prompt, or `''`.
 */
export function ucPresetText(model, index) {
  const family = ucFamilyFor(model)
  if (family === null) return ''
  const key = UC_PRESET_KEYS[Number(index)]
  if (key === undefined) return ''
  return OFFICIAL_UC_TEXT[family][key] ?? ''
}

/**
 * Apply a preset to a negative prompt.
 *
 * 出处与优先级（重要）
 * ------------------
 * 本函数的行为依据是**参考插件**，不是官方文档：
 *
 *   `NovelAI-PC-Clean` `app/backend.js` 的 `appendUcPreset`：
 *
 *     r ? [ /\bnsfw\b/i.test(s) ? r : `nsfw, ${r}`, s ].filter(Boolean).join(', ') : s
 *
 * 官方文档只规定**档位正文**（<https://docs.novelai.net/en/image/undesiredcontent>），
 * 对「正文如何与用户负向拼接」没有任何说明。既然参考插件大概率比我们更贴近实际客户端，
 * 在这类细节上**以参考插件为准**。
 *
 * 于是：
 *
 *  1. **负向为空时不追加。** 这是参考插件 `r ? … : s` 的原义；用户已明确此细节以参考插件为准，
 *     所以照抄，不另立规则。
 *  2. **不补 `nsfw, ` 前缀。** 这是参考插件（以及第三方 Python 客户端）会做、而**我们不**做的
 *     唯一一处偏离：本 profile 用于生成成人内容，注入 NSFW 压制与用途直接冲突。
 *     若某次确实需要压制，把 `nsfw` 写进负向即可 —— 那样它还会出现在 sidecar 里，
 *     而不是凭空出现。日后请勿以「对齐参考插件」为由把它加回来，这个偏离是刻意的。
 *
 * @param negativePrompt - the prompt's own negative text.
 * @param model - the model id, used to pick the preset family.
 * @param index - the `ucPreset` value.
 * @returns the negative prompt with the preset applied.
 */
export function applyUcPreset(negativePrompt, model, index) {
  const preset = ucPresetText(model, index)
  const user = String(negativePrompt ?? '').trim()
  if (preset === '') return user
  // 参考插件的 `r ? … : s`：预设是给负向做标注，不是替它从零创建。
  if (user === '') return user
  return `${preset}, ${user}`
}
