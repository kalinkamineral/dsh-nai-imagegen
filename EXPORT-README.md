# dsh-nai-imagegen — 导出包

NovelAI 文生图插件（DSH 宿主半侧 + 浏览器半侧）。出图落盘，Agent 在正文里内联显示。

---

## 包里**没有**什么

| 没带 | 为什么 |
| --- | --- |
| **任何 API Key** | `config.example.json` 里 `keys` 是空数组、`token` 是空串。Key 是你个人的凭据。 |
| **画师串归档** | `artists/index.json` 未包含。画师串里有你自己的风格库与参考图。 |
| **出图历史 / 图库** | 按机器的私有数据。 |
| 五大附体库索引 | 体积大且因机器而异，用 `nai_index` 重建。 |

已用 `pst-<20位以上>` 正则复检全包：**无真实令牌**（`tests/` 里有 `pst-contract-token…` 这类占位符，是测试桩，不是凭据）。

---

## 装到另一台 DSH

### 前置

- DSH（`$DSH_HOME` 通常是 `~/.dsh`）
- 一个能出图的 NovelAI 账号（Opus 订阅；**832×1216 @ 28 步在免费区间**，不消耗 Anlas）

### 步骤

**1. 放到位**

把 `dsh-nai-imagegen/` 整个复制到目标机 DSH 工作区，例如：

```
~\Documents\deepseek-harness\default-workspace\bundle-nai-imagegen
```

**2. 打进 profile**

```powershell
cd <插件目录>
node install.mjs            # 先看它打算做什么（dry run，不改任何东西）
node install.mjs --apply    # 确认后执行
```

它会写 bundle patch，**不动**你已有的其它插件。卸载：`node install.mjs --uninstall --apply`。

**3. 重启 DSH**

宿主代码**没有热更新**——`index.js` 和 `lib/*.js` 只在进程启动时加载，必须重启。

**4. 填凭据**

侧栏 →「NovelAI 生图」面板 → 填 NovelAI Persistent Token。
或设环境变量 `NAI_TOKEN`（进程启动时读取，会覆盖配置里的主 Key）。

需要走代理时在面板里填。**Node 的 `fetch` 不读系统代理**，插件自带 CONNECT 隧道，面板留空则自动探测系统代理（读取带 5 秒缓存）。

**5. 自检**

```powershell
# 让 Agent 调 nai_doctor，或直接打开：
http://127.0.0.1:19387/nai-imagegen/api/doctor
```

51 项能力检查，**不出图、不烧额度**。全绿再开始用。

---

## 可选：画师串

本包**不含**画师串。导入你自己的归档：

```powershell
node import-artists.mjs <你的画师串.json>          # dry run
node import-artists.mjs <你的画师串.json> --apply
```

归档格式：每行一个 JSON 对象，含 `name` / `positivePrompt` / `negativePrompt` / 参考图（base64 或路径）。

导入后生成 `$DSH_HOME/nai-imagegen/artists/index.json`。**参考图不整体载入内存**——按字节范围按需读取（1.8 MB 的图 3 ms 拿到）。

导入后可在侧栏或悬浮窗里选择；选择会被记住，重启不丢。

---

## 五大附体库

`标签库9.5 / 常规模板5.25 / 扩展库5.4 / 同人库8.5 / SEX模板9.2`

从 `$DSH_HOME/nai-imagegen/` 下的 jsonl 索引读取。**本包不含这些索引**。
缺库时 `nai_lookup` 会明确报告"索引目录为空"（不谎报），用 `nai_index` 重建。

**库内语法**

- `a/b/c` = 三选一
- `a,b,c` = 这几个一起去
- `[x]` = 必须替换的占位符（`[tag]` 在 NovelAI 里是降权，不是字面文本）
- `[中文]` = 待填占位

---

## 自证

```powershell
node tests/verify.mjs
```

**489 项断言，离线跑，不联网不出图。** 覆盖配置类型稳定化、Key 池调度、格式解析（插画 + 漫画）、文档契约、面板渲染、路由鉴权。全绿再开始用。

几个单独的探针也可以跑：`tests/format-probe.mjs`（分块扫描 1 B → 8 MB）、`tests/keypool-probe.mjs`、`tests/artists-probe.mjs`、`tests/live-panel.mjs`。

---

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主入口：15 个 `nai_*` 工具 + `/nai-imagegen/api/*` 路由 |
| `client.js` | 浏览器入口：侧栏面板、悬浮设置窗、代码块按钮、图片右键菜单 |
| `lib/character-edit.js` | 用提示词模型改写角色特征（固定特征 / 可选服装 / 关键字 / 负面） |
| `lib/dsh-go.js` | DSH Go（Android）原生界面：工具卡、输入框状态条、原生面板的视图与预算控制 |
| `lib/nai.js` | 请求构造与发送（代理隧道、V4/V5 角色 caption、网格→坐标） |
| `lib/keypool.js` | Key 池：N 个 Key = N 并发，LRU，429/5xx 冷却换 Key，401/403 停用 |
| `lib/format.js` | 插画格式 `<image>` 块解析（`Scene:` / `CharN:` / `CharN UC:`） |
| `lib/comic.js` | 漫画格式 `nai5-comic` 页解析（panels → caption，center → 坐标） |
| `lib/recipe.js` | 漫画配方：色彩 / 页数 / 分镜 / 留白 / 气泡 / 对白语言 |
| `lib/artists.js` | 画师串归档流式扫描与按需读图 |
| `lib/library.js` | 五大附体库检索与名册解析 |
| `lib/config.js` | 配置读写、类型稳定化、**按模式分离的设置** |
| `lib/doctor.js` | 自检 |
| `README-install.md` | 安装与全部功能说明 |
| `README-comic.md` | **漫画输出格式硬性规范**（含可直接贴给模型的指令块） |

---

## 两种出图模式

`mode: auto`（默认）按输入自动判定，两套设置**完全分开**：

| 输入 | 走哪套 | 说明 |
| --- | --- | --- |
| `nai5-comic` 页 | 漫画设置 + 漫画配方 | 一页 = 一个 `<image>` 包 JSON |
| `<image>` 块 | 出图设置 | `Scene:` / `Char1:` / `Char1 UC:` 标签式 |
| 普通提示词 | 出图设置 | 整段原样发出 |

出图与漫画各有自己的**画师串、尺寸、步数、引导、负面词、UC 预设**——只声明差异，
留空的项沿用公共默认。悬浮窗（右下角 🎛）里切换调整。

---

## 许可

MIT。
