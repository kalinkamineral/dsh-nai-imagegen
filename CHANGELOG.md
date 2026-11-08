# Changelog

## 2026-11-08 · 0.7.0

### 参考来源

- **st-chatu8**：它的「破限」其实是两件事——用大段 system 提示强制模型**只走 toolcall 输出**（含 reasoning/audit 的伪造接管文本），以及在提示里预先声明 NSFW 创作许可。
- **nai-dbgen**：写词走可编辑的 imagegen preset（worldinfo / 角色 / 构图 / 特征 / 常驻标签分块），拒绝是单独的错误码，不自动重试。
- **沉浸式Galgame 脚本 JSON**：实为自动更新加载器（从 jsDelivr 拉远端），本身不含破限或工具调用提示，只能参考其「加载器 + 运行时」结构。

### Added

- **写词的「成人向创作范围」开关**（`writerAdult`，默认关）：在写词 system 里说明这是成年人之间的虚构插画、角色均为成年人、输出标签而非叙述；开启后，模型拒绝时自动改用更直接的指令重试一次。
- **写词的「工具调用输出」开关**（`writerToolCall`，默认关）：要求模型只回一个 `{"tool":"submit_caption","arguments":{…}}`，插件再摊平成原有字段语法（对应 st-chatu8 强制 toolcall 的思路，但不使用伪造系统接管的文本）。
- 面板设置新增「写提示词」卡片，两个开关可直接切换；`nai_config` 也支持 `writer_adult` / `writer_tool_call`。
- 新增 `augmentWriterSystem()`、`toolCallArguments()`、`toolCallToFlat()`，以及 3 条离线测试。

### Notes

- 没有采用 st-chatu8 那套「伪造 KERNEL 接管 / 审计通过」的提示词：它依赖欺骗模型对系统提示的信任，且换模型后行为不可预期。成人范围说明是如实声明适用范围，不是绕过安全策略的伪装。

## 2026-11-08 · 0.6.1

### Fixed

- **离线测试污染真实出图日志**：`npm run verify` 之前用真实的 `DSH_HOME` 运行，每条故意失败的用例（32×32 蒙版、`__definitely_missing__.png`、不支持的导演工具等）都会写进 `~/.dsh/nai-imagegen/logs`，面板因此显示大量假的「出图失败」。
  - 新增 `tests/run.mjs`：先把 `DSH_HOME` 指向临时目录再加载测试，日志、角色库等状态全部隔离。
  - `npm run verify` 与 CI 改为走 `tests/run.mjs`。
  - 附带 `scripts/clean-test-log.py`，可按固定摘要清掉历史噪音（自动 `.bak` 备份）。

## 2026-11-08 · 0.6.0

### Changed

- **生图请求链路对齐参考插件**（nai-dbgen / st-chatu8）：
  - 新增**单次请求总时限**（默认 300000 ms，配置项 `requestTimeoutMs`）。原来的空闲超时只能发现连接彻底安静；一个每分钟滴几字节的中转能让请求无限挂着。
  - V5 请求补上官方客户端与 st-chatu8 都会发送的 `use_new_shared_trial`（仅 v5 生效，配置项 `useNewSharedTrial`）。
  - **URL 回退**：baseUrl 带自定义挂载路径时，先请求 `<base>/ai/generate-image`，遇到 404/405 再试原始 baseUrl（st-chatu8 的多候选逻辑）。只在这两个状态码回退，真正的生成失败绝不重发，避免重复计费。
  - 连接阶段失败（`phase: 'connect'`）也允许换候选 URL 再试一次，因为请求没有到达模型。

### Config

- `requestTimeoutMs`：默认 300000，0 表示不限。
- `useNewSharedTrial`：默认 true，仅对 v5 模型写入请求体。

## 2026-11-07 · 0.5.1

### Changed

- 网页版插件页位置改为**自适应布局**：窄窗口保持侧栏单栏，≥1100px 放宽到 1240px 并把参数网格加到 3 列，≥1440px 放宽到 1520px / 4 列；宽屏下导航靠左紧凑排列，不再拉成一排巨页签。

## 2026-11-07 · 0.5.0

### Changed

- **DSH Go 原生面板重做为侧栏同构的 5 页签**：创作 / 编辑 / 图库 / 资料库 / 设置，一个面板完成原来分散的入口。
  - 创作：全部出图参数、AI 写词、画师串列表、进度、结果。
  - 编辑：源图列表、重绘强度、工具（img2img / 线稿 / 草图 / 上色 / 表情 / 去杂物）、运行与取消；蒙版重绘注明需网页版。
  - 图库：最近作品 + 刷新 + 复制路径。
  - 资料库：五库检索 + 结果复制。
  - 设置：接口/解码/代理/默认参数保存、自检、Key 池摘要。
- **网页版插件页位置（非侧栏）改用同一套侧栏布局**：不再维护两套前端，插件页居中限宽显示。

### Removed

- 独立的 `novelai-studio` 面板（并入「创作」页签）。
- 网页版插件页那份旧的整页设置表单不再渲染（代码保留待清理）。

## 2026-11-07 · 0.4.0

### Added

- **输入框胶囊「AI 写词」**（`composer.actions` + `wants: ['draft']`）：把输入框里刚写的句子带进工作台的写词框并打开面板；没有文字时只打开面板。
- **工具 `nai_write_prompt`**：对话里直接调用写词模型，返回正向/负面/角色标签，不出图；可与 `nai_generate` 接力。

## 2026-11-07 · 0.3.0

### Added

- **DSH Go 工作台内嵌「AI 写词」**：一句话描述直接调写词模型，结果回填到工作台表单。
  - 新输入框（`data.writer.text`）+ `write` / `cancelWrite` 两个动作，单会话单任务、可取消。
  - 回填规则：`caption.base` 替换提示词；`baseNegative` 追加到负面；角色正面拼进提示词、负面拼进负面提示词；返回的尺寸命中预设时同步尺寸。
  - 错误分档：模型拒绝、格式不合格、无模型、取消。
- 工作台数据新增 `writerText` / `writerBusy` / `writerError` 与 `writer.text` 草稿字段。

### Tests

- 53 项离线测试（新增：写词区块绑定、草稿同步、空描述拒绝、取消、回填与错误映射）。

## 2026-11-07 · 0.2.0

### Added

- **DSH Go 原生生图工作台**（`novelai-studio` 面板）：提示词、负面提示词、尺寸、模型、采样器、步数、张数、种子、画师串开关；点「生成」后在后端起任务，面板实时显示耗时与已收字节，完成后列出文件并可复制路径；支持取消。
- 工作台的输入用 `onChange: 'changed'` 同步回宿主，周期推送不会覆盖正在编辑的内容。
- 老版本 App 没有表单组件时，面板自动降级为 v1 提示，不显示灰色占位。

### Changed

- `renderLogged` 在调用方自带进度回调时仍会更新日志里的 TTFB / 字节数。

## 2026-11-07

### Added

- **用提示词改角色特征**：`nai_character_edit` 工具 + 角色编辑器入口，结果先填表单、确认后再保存。
- **DSH Go（Android）适配**：`nai_generate` / `nai_estimate` / `nai_probe` 原生工具卡；输入框余额状态条；原生 NovelAI 面板（余额、角色、最近作品）。
- **出图进度**：等待条显示已接收字节 / 总大小，日志记录 `ttfbMs` 与 `bytes`。
- **解码选项**：`json`（默认）/ `zip` / `auto`，面板下拉选择。
- **连接阶段重试**：请求未连上时自动重试 2 次（不影响计费安全）。
- `DESIGN.md`：面板设计语言与 token 规范。

### Changed

- 默认解码改为 `json`（与 nai-dbgen 的「自动」同路径）。
- 面板视觉：8px 节奏、轻卡片、统一 32px 控件、聚焦环。

### Removed

- 悬浮窗（floating studio）。
- 按模式覆盖（per-mode overrides）：只保留一套共享默认值，旧配置里的 `modes` 被忽略。
- 分享版不再携带 token / 画师串 / 角色数据。

### Fixed

- `/config` 保存接口白名单缺少 `decode`，导致面板选择被静默丢弃。
- 连接阶段失败会立刻放弃整批任务，改为先重试。
