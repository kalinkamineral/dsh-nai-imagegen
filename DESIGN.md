# DESIGN.md — dsh-nai-imagegen 面板设计语言

参考 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) 的 DESIGN.md 方法：
把设计意图写成代理能直接执行的规则，再落到代码里的 token 与规则上。

本插件是 **DSH 侧栏里的工作面板**，不是营销页：信息密度高、操作频繁、状态多。
因此取这套集合里三个开发工具的气质——**Linear 的精确**、**Vercel 的黑白克制**、
**Raycast 的深色 chrome**——合成一个中性、可长时间盯着看的工作台。

## 1. 原则

1. **内容先于装饰。** 没有渐变、没有大圆角、没有彩色底；颜色只用来表达状态（ok / warn / bad）。
2. **一个 8px 节奏。** 间距只用 4 / 8 / 12 / 16 / 24，禁止 5、7、9 这种随手值。
3. **层级靠字重和颜色，不靠字号堆叠。** 正文 13px，辅助 11.5px，标签 11px；层级主要由 `--ink` → `--ink2` → `--ink3` 的灰阶差完成。
4. **每条边都是 1px。** 分隔线用 `--line-soft`，容器边用 `--line`，交互悬停升到 `--line-strong`。
5. **动效只用来解释状态变化。** 120–160ms，`ease` 系列；不做位移、缩放、弹跳。尊重 `prefers-reduced-motion`（沿用宿主的 media 规则）。
6. **深色优先，浅色同构。** 所有颜色来自宿主的 `--dsw-*` token；面板自己只定义语义别名（`--ink`、`--paper`、`--wash`…），保证随宿主主题切换。
7. **每屏一个主操作。** 主按钮是唯一的实心黑色按钮；其余是 ghost / 描边。
8. **可扫描的状态。** 状态用 7px 圆点 + 一行等宽数字，不用图标墙。

## 2. Token

| 类别 | token | 值（带宿主 fallback） | 用途 |
| --- | --- | --- | --- |
| 文字 | `--ink` / `--ink2` / `--ink3` / `--ink4` | 宿主 label-primary / secondary / tertiary / caption | 正文 / 次要 / 标签 / 极弱 |
| 表面 | `--paper` / `--wash` | 宿主 bg-layer-1 / bg-module-platform | 面板底 / 分区底 |
| 边线 | `--line-soft` / `--line` / `--line-strong` | 宿主 border-l1 / l2 / l4 | 分隔 / 容器 / 悬停 |
| 主色 | `--primary` / `--on-primary` | 宿主 brand-primary / label-primary-foreground | 唯一实心按钮 |
| 状态 | `--ok` / `--warn` / `--bad` | #1f9d55 / #c27c0e / #d93025 | 成功 / 注意 / 错误 |
| 圆角 | `--r-sm` / `--r-md` | 宿主 radius-sm / radius-md（8 / 12） | 输入与按钮 / 卡片与提示条 |
| 字号 | 正文 13 / 辅助 11.5 / 标签 11 | px | — |
| 间距 | 4 / 8 / 12 / 16 / 24 | px | gap / padding |
| 阴影 | `0 1px 2px ink 4%`；悬停 `0 2px 6px ink 7%` | — | 卡片层级 |

## 3. 组件规则

- **状态条**：11.5px，灰阶文字 + 状态圆点；点击进入面板。不抢注意力。
- **标签页**：13px，选中态字重 600 + 2px 下划线，不做底色。
- **卡片**：1px 边 + 8px 内边距起；标题 13px/600，右侧摘要 11.5px 等宽；悬停只加边框与一层浅阴影。
- **分区标题**：11px/600，字距 +.06em，上边一条 `--line-soft` 分隔线，读作“章节”而非“按钮”。
- **输入**：32px 高，8px 圆角；聚焦时边框到 `--ink3` 并加 3px 极浅外环；不要彩色光晕。
- **按钮**：32px 高；主按钮实心（带 1px 阴影），次按钮描边，破坏性操作只在悬停时染红。
- **提示条（flash）**：12px，8px 圆角；success / warning / error 只染文字与 9% 底，不用整块彩色。
- **空状态**：居中、虚线边、极浅底；一行说明，不放大图。
- **等宽数字**：seed、Anlas、id、路径一律 `--mono` + `tabular-nums` 语义（等宽字体本身）。

## 4. 已退役的界面

- ❌ 悬浮窗（floating studio）：可拖拽的按模式设置窗口。
- ❌ 按模式覆盖（per-mode overrides）：出图 / 漫画各自一套尺寸、模型、画师串、配方的设置。
  现在只有一套共享默认值；旧配置里的 `modes` 会被忽略，不再影响出图。
