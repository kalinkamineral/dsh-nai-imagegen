# Changelog

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
