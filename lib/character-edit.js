/**
 * dsh-nai-imagegen — rewrite a character's features with the prompt model.
 *
 * The character library is edited by hand: fixed DNA, named outfits, keywords,
 * negative tags. Rewriting one used to mean retyping every field, and a request
 * like 「把发色改成银白色，加一副眼罩」 touched three fields at once. This module
 * turns one instruction plus the current settings into one model call that
 * returns the whole updated character as JSON — the same route the prompt
 * writer and the DNA-from-image reader use (`lib/llm.js`), so the panel's
 * 「提示词模型」 setting applies here too.
 *
 * Design rules, kept the same as `writer.js` so the panel behaves predictably:
 *
 *   - Nothing is saved here. `editCharacter` returns a draft; the caller (the
 *     panel's edit form, or the `nai_character_edit` tool with `apply: true`)
 *     decides whether to persist it.
 *   - A reply that is not the requested JSON gets one corrective retry, then
 *     stops with `CHARACTER_EDIT_INVALID`.
 *   - A content refusal stops at once (`WRITER_REFUSED`), because asking again
 *     with the same input cannot get past a provider filter.
 *   - Every call leaves one `character` entry in the debug log, including the
 *     exact prompt and the head/tail of each reply, like a `write` entry.
 */
import { logEvent } from './log.js'
import { complete, extractJson } from './llm.js'
import { WRITER_REFUSED, detectRefusal } from './writer.js'
import { splitKeywords } from './characters.js'

/** Error code for "the model did not return the requested JSON". */
export const CHARACTER_EDIT_INVALID = 'CHARACTER_EDIT_INVALID'

/**
 * The system prompt. The JSON shape matches the character fields one for one so
 * the result can be merged into the edit form without a second mapping.
 */
export const CHARACTER_EDIT_SYSTEM = `你是角色设定编辑助手。用户会给你一个角色的现有设定（固定特征、可选服装、关键字、负面标签）和一句修改要求。请按要求改写这个角色，只输出一个 JSON 对象。

输出形状（只输出一个 JSON 对象，不要 Markdown，不要代码块，不要在 JSON 之外写任何解释）：
{"analysis":"","name":"","keywords":[],"fixedFeatures":"","variableFeatures":[{"name":"","prompt":""}],"negative":"","notes":""}

字段规则：
1. fixedFeatures 只写每张图都不变的外貌：能认出的现有角色，先写它的 Danbooru 角色标签和作品标签；然后是发色、发长、发型，瞳色，肤色，体型，种族特征（兽耳、尾巴、角、翅膀等），明显的痣、疤、纹身等标记，常驻配饰。不要写服装、姿势、表情、背景、镜头、画风或画师标签。
2. 提示词一律用英文 Danbooru 标签，英文逗号分隔。只有 name、variableFeatures[].name、analysis、notes 用中文。
3. 只改用户明确要求改的部分；其余字段尽量原样保留（措辞和顺序都不动），除非它与新要求直接冲突。
4. 服装、装备、造型的改动写进 variableFeatures，一项一套，name 用中文（例如「默认装束」「修改后的服装」）；不要把服装塞进 fixedFeatures。
5. keywords 是写提示词时用来称呼这个角色的词：中文名、罗马字、Danbooru 角色标签，用字符串数组给出，保留原有词条。
6. negative 写会破坏角色辨识度的标签（例如错误的发色、错误的瞳色）；没有就写空字符串。
7. analysis 用简体中文写一两句：改了什么、保留了什么、哪里不确定。
8. 如果用户的修改要求和原设定矛盾，以用户的新要求为准，并在 analysis 里说明改掉了什么。
9. 用户没有要求改名字时，name 原样返回。`

/** The user message template; both placeholders are filled by `characterEditPrompt`. */
export const CHARACTER_EDIT_USER = `【角色现有设定】
{{角色设定}}

【修改要求】
{{修改要求}}`

/**
 * Fill the template placeholders, leaving unknown ones untouched.
 * @param template - the template text.
 * @param vars - replacement values by placeholder name.
 * @returns the filled text.
 */
function fillTemplate(template, vars) {
  return String(template).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole))
}

/**
 * Normalize whatever the caller passed as "the current character".
 *
 * Accepts the editor's draft shape (`keywords` as an array or as the raw comma
 * separated text, `variableFeatures` possibly absent) and drops unknown fields.
 * Keeping this tolerant matters: the panel sends an unsaved draft, the tool
 * sends a record loaded from disk.
 *
 * @param raw - an untrusted character-like object.
 * @returns `{ id, groupId, name, keywords, fixedFeatures, variableFeatures, negative }`.
 */
export function normalizeEditBase(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const keywords = Array.isArray(value.keywords)
    ? value.keywords.map((row) => String(row).trim()).filter((row) => row !== '')
    : splitKeywords(String(value.keywords ?? ''))
  const variableFeatures = Array.isArray(value.variableFeatures)
    ? value.variableFeatures
        .filter((row) => row !== null && typeof row === 'object')
        .map((row) => ({ name: String(row.name ?? '').trim(), prompt: String(row.prompt ?? '').trim() }))
        .filter((row) => row.name !== '' || row.prompt !== '')
    : []
  return {
    id: typeof value.id === 'string' ? value.id : '',
    groupId: typeof value.groupId === 'string' ? value.groupId : '',
    name: String(value.name ?? '').trim(),
    keywords,
    fixedFeatures: String(value.fixedFeatures ?? '').trim(),
    variableFeatures,
    negative: String(value.negative ?? '').trim()
  }
}

/**
 * The prompt for one rewrite.
 *
 * Pure, so the test suite and `nai_doctor` can check the template without a
 * model: the character JSON must show up in the user message and so must the
 * instruction.
 *
 * @param character - the current character (any shape `normalizeEditBase` accepts).
 * @param instruction - the user's request, in natural language.
 * @returns `{ system, user }`.
 */
export function characterEditPrompt(character, instruction) {
  const base = normalizeEditBase(character)
  const vars = {
    角色设定: JSON.stringify(
      {
        name: base.name,
        keywords: base.keywords,
        fixedFeatures: base.fixedFeatures,
        variableFeatures: base.variableFeatures,
        negative: base.negative
      },
      null,
      2
    ),
    修改要求: String(instruction ?? '').trim()
  }
  return {
    system: fillTemplate(CHARACTER_EDIT_SYSTEM, vars),
    user: fillTemplate(CHARACTER_EDIT_USER, vars)
  }
}

/**
 * Problems that mean "this reply is not the JSON we asked for".
 * @param value - the parsed JSON.
 * @returns an issue list; empty when usable.
 */
export function validateEditReply(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['没有可解析的 JSON 对象']
  const issues = []
  const fixed = value.fixedFeatures ?? value.fixed_features ?? value.dna
  if (typeof fixed !== 'string') issues.push('缺少字符串字段 fixedFeatures')
  const variable = value.variableFeatures ?? value.variable_features ?? value.outfits
  if (variable !== undefined && variable !== null && !Array.isArray(variable)) issues.push('variableFeatures 必须是数组')
  return issues
}

/**
 * Turn a model reply into the character fields the edit form uses.
 *
 * Missing fields fall back to the current character, empty ones are honoured —
 * "clear this outfit list" is a legitimate request, so an empty array from the
 * model is not replaced by the old list.
 *
 * @param value - the parsed JSON.
 * @param base - the current character.
 * @returns `{ name, keywords, fixedFeatures, variableFeatures, negative, analysis, notes }`.
 */
export function normalizeEditDraft(value, base = {}) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const current = normalizeEditBase(base)
  const text = (...keys) => {
    for (const key of keys) if (typeof source[key] === 'string') return source[key].trim()
    return null
  }
  const keywords = Array.isArray(source.keywords)
    ? source.keywords.map((row) => String(row).trim()).filter((row) => row !== '')
    : typeof source.keywords === 'string'
      ? splitKeywords(source.keywords)
      : null
  const variableSource = source.variableFeatures ?? source.variable_features ?? source.outfits
  const variableFeatures = Array.isArray(variableSource)
    ? variableSource
        .filter((row) => row !== null && typeof row === 'object')
        .map((row) => ({ name: String(row.name ?? row.title ?? '').trim(), prompt: String(row.prompt ?? row.tags ?? '').trim() }))
        .filter((row) => row.name !== '' || row.prompt !== '')
    : null
  const fixed = text('fixedFeatures', 'fixed_features', 'dna')
  const negative = text('negative', 'negativePrompt', 'negative_prompt')
  const name = text('name', 'characterName')
  return {
    name: name !== null && name !== '' ? name : current.name,
    keywords: keywords !== null ? keywords : current.keywords,
    fixedFeatures: fixed !== null ? fixed : current.fixedFeatures,
    variableFeatures: variableFeatures !== null ? variableFeatures : current.variableFeatures,
    negative: negative !== null ? negative : current.negative,
    analysis: text('analysis', 'summary') ?? '',
    notes: text('notes', 'note', 'comment') ?? ''
  }
}

/**
 * Merge a draft over the character it came from, keeping the host-owned fields
 * (`id`, `groupId`, `createdAt`, cover version…). Used by the apply path.
 * @param base - the stored character.
 * @param draft - `normalizeEditDraft`'s result.
 * @returns a character object safe to pass to `saveCharacter`.
 */
export function mergeEditDraft(base, draft) {
  const current = normalizeEditBase(base)
  const next = draft ?? {}
  return {
    ...(base !== null && typeof base === 'object' ? base : {}),
    id: current.id || undefined,
    groupId: current.groupId || undefined,
    name: typeof next.name === 'string' && next.name.trim() !== '' ? next.name.trim() : current.name,
    keywords: Array.isArray(next.keywords) ? next.keywords : current.keywords,
    fixedFeatures: typeof next.fixedFeatures === 'string' ? next.fixedFeatures : current.fixedFeatures,
    variableFeatures: Array.isArray(next.variableFeatures) ? next.variableFeatures : current.variableFeatures,
    negative: typeof next.negative === 'string' ? next.negative : current.negative
  }
}

/** First 1500 and last 500 characters of a reply, for the log. */
function headTail(text, head = 1500, tail = 500) {
  const raw = String(text ?? '')
  if (raw.length <= head + tail) return { head: raw, tail: '' }
  return { head: raw.slice(0, head), tail: raw.slice(-tail) }
}

/**
 * One attempt, as the log records it.
 * @param n - attempt number, from 1.
 * @param started - when it started (ms).
 * @param reply - `complete()`'s result, or `null` when it threw.
 * @param issues - validation issues, or `[]`.
 * @param error - the thrown error, if any.
 * @returns the attempt record.
 */
function attemptRecord(n, started, reply, issues = [], error = null) {
  if (reply === null) {
    return {
      n,
      ms: Date.now() - started,
      finishKind: error?.finishKind ?? null,
      usage: error?.usage ?? null,
      error: String(error?.message ?? error),
      ...(error?.code ? { code: error.code } : {})
    }
  }
  const { head, tail } = headTail(reply.text)
  return {
    n,
    ms: Date.now() - started,
    finishKind: reply.finishKind ?? null,
    usage: reply.usage ?? null,
    truncated: reply.truncated === true,
    chars: reply.text.length,
    replyHead: head,
    replyTail: tail,
    issues
  }
}

/**
 * The message shown for a provider refusal; the same wording style as `writer.js`.
 * @param route - `{ provider, model }` or `null`.
 * @param reason - the provider's own words.
 * @returns the message.
 */
function refusalMessage(route, reason) {
  const who = route === null ? '模型' : `模型（${route.provider}/${route.model}）`
  const why = String(reason ?? '').replace(/[\s.。]+$/u, '')
  return `${who}拒绝了这次角色改写，原因是它的内容审核，不是格式问题：${why}。可以换一个模型（设置 → 提示词模型），或换一种说法再试。`
}

/**
 * Rewrite one character with the configured prompt model.
 *
 * The caller decides whether to save the result: the panel drops it into the
 * edit form, the tool saves it only when `apply` is set.
 *
 * @param ctx - the plugin's root context (for `ctx.get('llm')`).
 * @param input - `{ character, instruction, config, signal? }`.
 * @returns `{ draft, raw, route, attempts, logId }`.
 */
export async function editCharacter(ctx, input) {
  const started = Date.now()
  const config = input?.config ?? {}
  const base = normalizeEditBase(input?.character)
  const instruction = String(input?.instruction ?? '').trim()
  const attempts = []
  let system = ''
  let userText = ''
  let route = null

  const record = (outcome, level, summary, extra = {}) =>
    logEvent('character', {
      level,
      summary,
      outcome,
      route,
      character: base.name,
      characterId: base.id || null,
      instruction,
      systemChars: system.length,
      userChars: userText.length,
      userPrompt: userText,
      attempts,
      ms: Date.now() - started,
      ...extra
    })

  try {
    if (instruction === '') throw Object.assign(new Error('先写一句要怎么改这个角色'), { status: 400 })
    if (base.name === '' && base.fixedFeatures === '' && base.variableFeatures.length === 0 && base.keywords.length === 0) {
      // Not an error: writing a brand-new character from one sentence is useful.
      // The prompt then carries empty fields, which the system prompt allows.
    }
    const prompt = characterEditPrompt(base, instruction)
    system = prompt.system
    userText = prompt.user

    const call = async (promptText) => {
      const attemptStarted = Date.now()
      try {
        const reply = await complete(ctx, {
          system,
          prompt: promptText,
          maxTokens: Number(config.llmMaxTokens) > 0 ? Number(config.llmMaxTokens) : undefined,
          signal: input?.signal,
          config
        })
        route = { provider: reply.provider, model: reply.model }
        return { reply, attemptStarted }
      } catch (error) {
        attempts.push(attemptRecord(attempts.length + 1, attemptStarted, null, [], error))
        throw error
      }
    }
    const judge = ({ reply, attemptStarted }) => {
      const value = extractJson(reply.text)
      const issues = validateEditReply(value)
      attempts.push(attemptRecord(attempts.length + 1, attemptStarted, reply, issues))
      if (issues.length === 0) return value
      const refusal = detectRefusal(reply.text)
      if (refusal !== null) {
        const logId = record('refused', 'warn', `模型拒绝了角色改写（内容审核）${base.name ? ` · ${base.name}` : ''}`, { reason: refusal.reason })
        throw Object.assign(new Error(refusalMessage(route, refusal.reason)), {
          code: WRITER_REFUSED,
          status: 422,
          refusal: true,
          reason: refusal.reason,
          raw: reply.text,
          attempts: attempts.length,
          route,
          logId
        })
      }
      return null
    }

    let answer = await call(userText)
    let value = judge(answer)
    if (value === null) {
      answer = await call(
        [
          userText,
          '',
          '======== 上一轮回复（不是可用的 JSON）========',
          answer.reply.text.trim() || '（上一轮返回为空）',
          '======== 上一轮回复结束 ========',
          '',
          '上一次回复不是要求的 JSON 对象，或缺少 fixedFeatures。请只输出那一个 JSON 对象，不要 Markdown，不要代码块，不要解释。'
        ].join('\n')
      )
      value = judge(answer)
    }
    if (value === null) {
      const issues = validateEditReply(extractJson(answer.reply.text))
      const logId = record('invalid', 'warn', `角色改写没有返回 JSON · 试了 ${attempts.length} 次${base.name ? ` · ${base.name}` : ''}`, { issues })
      throw Object.assign(new Error('模型两次都没有返回可用的角色 JSON，已停止。'), {
        code: CHARACTER_EDIT_INVALID,
        status: 422,
        issues,
        raw: answer.reply.text,
        attempts: attempts.length,
        route,
        logId
      })
    }
    const draft = normalizeEditDraft(value, base)
    const logId = record('ok', 'info', `角色改写成功${base.name ? ` · ${base.name}` : ''} · ${attempts.length} 次 · ${route?.provider ?? '?'}/${route?.model ?? '?'}`)
    return { draft, raw: answer.reply.text, route, attempts: attempts.length, logId }
  } catch (error) {
    if (error?.logId) throw error
    const aborted = input?.signal?.aborted === true
    error.logId = record(aborted ? 'aborted' : 'error', aborted ? 'info' : Number(error?.status) >= 400 && Number(error?.status) < 500 ? 'warn' : 'error', aborted ? '角色改写已取消' : `角色改写失败：${String(error?.message ?? error).slice(0, 80)}`, {
      error: String(error?.message ?? error),
      ...(error?.code ? { code: error.code } : {})
    })
    throw error
  }
}
