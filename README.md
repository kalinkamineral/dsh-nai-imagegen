# dsh-nai-imagegen

[简体中文](README.md) · [English](README.en.md)

[![verify](https://github.com/kalinkamineral/dsh-nai-imagegen/actions/workflows/verify.yml/badge.svg)](https://github.com/kalinkamineral/dsh-nai-imagegen/actions/workflows/verify.yml) [![release](https://img.shields.io/github/v/release/kalinkamineral/dsh-nai-imagegen)](https://github.com/kalinkamineral/dsh-nai-imagegen/releases)

DeepSeek Harness（DSH）的 NovelAI 出图插件：右侧栏面板 + 一组 `nai_*` 工具，由 Agent 直接调用。

> 非官方项目。需要你自己准备 NovelAI 账号的 Persistent Token（或一个可用的中转站）。

## 功能

- **文生图**：Danbooru 标签 / `<image>` 结构化块 / `nai5-comic` 漫画页；尺寸、步数、模型、采样器、seed、多张
- **图生图 / 局部重绘**：底图限制在专用输入目录内，自动校验格式、尺寸、字节数
- **导演工具**：lineart / sketch / colorize / emotion / declutter（不消耗 Anlas）
- **角色库（DNA）**：固定特征、可选服装、关键字、参考图；「用提示词改特征」
- **画师串**：导入索引、搜索、预览、临时覆盖
- **写提示词**：调用 DSH 配置的模型，把一句话 / 参考图写成结构化提示词
- **Key 池**：多 Key 多并发出图，401/403 停用、429/5xx 冷却换 Key
- **DSH Go（Android）**：与侧栏同构的原生面板（创作 / 编辑 / 图库 / 资料库 / 设置 五页签）、原生图库缩略图与查看器、角色库/画师串搜索、输入框「AI 写词」胶囊、原生工具卡、余额状态条
- **调试日志**：写词 / 出图 / 连接测试全部留痕（含 TTFB 与下载字节数）

## 下载

- **分享版**（不含 token / 画师串 / 角色数据）：[Releases](https://github.com/kalinkamineral/dsh-nai-imagegen/releases/latest) 里的 `dsh-nai-imagegen-friend-*.zip`
- 开发者直接克隆仓库安装即可（见下）。

## 安装

### 桌面版 DSH

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

然后重启 DSH。详见 [README-install.md](README-install.md)。

### DSH Go（Android）

把仓库目录放到手机本机环境的 `/root/.dsh/dsh-go/plugins/`，再：

```sh
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-nai-imagegen
```

## 配置

侧栏 NovelAI → 设置 → 连接：

| 字段 | 说明 |
| --- | --- |
| 接口地址 | 官方 `https://image.novelai.net`，或你的中转站地址 |
| Token | NovelAI Persistent Token（`pst-` 开头） |
| 解码 | `json`（默认） / `zip`（体积最小） / `auto`（跟随响应） |
| 代理 | 留空直连；`auto` 跟随系统代理；或填 `http://127.0.0.1:7890` |
| 请求总时限 | 单次出图的总时限，默认 300000 ms（5 分钟），`0` 关闭 |
| V5 共享试用 | 是否发送 `use_new_shared_trial`（仅 V5），默认开 |
| 成人向创作范围 | 写词时附加成年人虚构插画的范围说明（默认关，开启后被拒自动重试一次） |
| 工具调用输出 | 写词改走 JSON toolcall 再摊平成字段（默认关） |

也可以让 Agent 用 `nai_config` 修改，或直接编辑 `$DSH_HOME/nai-imagegen/config.json`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `nai_generate` | 文生图 |
| `nai_img2img` | 图生图 |
| `nai_inpaint` | 局部重绘 |
| `nai_director` | 导演工具后处理 |
| `nai_estimate` | 出图前估算消耗 |
| `nai_lookup` / `nai_resolve` | 五库检索 / 同人角色解析 |
| `nai_index` | 重建五库索引 |
| `nai_status` | 插件状态 |
| `nai_probe` | 连通性与订阅检测（不花 Anlas） |
| `nai_keys` | Key 池管理 |
| `nai_artists` | 画师串 |
| `nai_character_edit` | 用提示词改写角色特征 |
| `nai_write_prompt` | 一句话写成结构化提示词（含角色标签），不出图 |
| `nai_doctor` | 能力自检 |
| `nai_config` | 修改配置 |

## 目录

```
index.js          宿主半侧：工具与 HTTP API
client.js         浏览器半侧：侧栏面板（手写预构建）
lib/              网络、配置、角色、画师串、DSH Go 视图等
tests/run.mjs     离线测试入口（隔离 DSH_HOME，不污染真实日志）
DESIGN.md         面板设计语言与 token
config.example.json
```

## 开发

```sh
npm run verify   # 64 项离线检查
```

无外部运行时依赖，只需要 Node.js 22.19+。改动宿主代码后需重启 DSH；仅前端改动刷新页面即可。

## 许可

[MIT](LICENSE)
