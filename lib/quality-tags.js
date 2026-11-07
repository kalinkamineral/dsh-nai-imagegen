/**
 * dsh-nai-imagegen — 官方质量词（Quality Tags）。
 *
 * 行为与出处
 * ----------
 * 开启时把一段质量词**追加到正向提示词的末尾**。V4.5 Full 与 V5 Full 都是：
 *
 *     very aesthetic, masterpiece, no text
 *
 * 同时请求体里带一个 `qualityToggle` 布尔字段，作用与 `ucPreset` 同类：
 * **它是元数据**，供网页端导入图片时还原开关状态。
 *
 * 出处（注意强度差异）：
 *   - 【官方】质量词正文见 <https://docs.novelai.net/en/image/qualitytags>。
 *   - 【第三方·强旁证】「追加到末尾」这一点由开源参考插件 `NovelAI-PC-Clean` 的
 *     `Ld` 实现佐证：`[prompt, quality].join(', ')`。该插件是**第三方项目**，
 *     并非 NovelAI 官方发布。
 *
 * 为什么只有一档
 * --------------
 * 参考插件里有 `qualityPreset` 三档（standard / light / none），**不按模型分档**：
 *
 *     standard = 'very aesthetic, masterpiece, no text'
 *     light    = 'very aesthetic, amazing quality, no text'
 *     none     = ''
 *
 * 而 `qualityToggle` 是与之联动的开关：关掉即强制 'none'。既然本项目只需要
 * 一个「默认关、可手动开」的开关，就不必把三档选择器也搬进来 —— 开启即等价于
 * 选 standard。日后若真要三档，在这个文件加一张表即可，消费点不用改。
 *
 * ⚠️ 与画师串重复的风险
 * --------------------
 * 本项目的风格词来自画师串，而画师串里常自带 `masterpiece, best quality, very aesthetic`
 * 之类（例如 p3串）。开启本开关会**重复**这些词，权重叠加。
 * 因此默认关闭，且这里**不做去重** —— 去重会改写用户画师串的语义，那是更坏的选择。
 */

/**
 * 官方质量词正文，按档位名分组。
 *
 * 逐字抄自 NovelAI-PC-Clean `app/backend.js` 的 `Rd` 表（该表与
 * nai-dbgen 的 `OFFICIAL_QUALITY_TAGS` 在 standard 一档上一致）。
 */
export const OFFICIAL_QUALITY_PRESETS = Object.freeze({
  standard: 'very aesthetic, masterpiece, no text',
  light: 'very aesthetic, amazing quality, no text',
  none: ''
})

/** 开启开关时采用的档位；与官方勾选「Add Quality Tags」的默认档一致。 */
export const DEFAULT_QUALITY_PRESET = 'standard'

/**
 * 要追加到正向末尾的质量词。
 *
 * @param on - 开关状态。只有显式 `true` 才算开：`undefined` 与 `1` 都不注入，
 *   避免把「未配置」当成「用户想要」——默认关是这个功能的明确要求。
 * @returns 质量词，关闭时为空串。
 */
export function qualityTagText(on) {
  return on === true ? OFFICIAL_QUALITY_PRESETS[DEFAULT_QUALITY_PRESET] : ''
}
