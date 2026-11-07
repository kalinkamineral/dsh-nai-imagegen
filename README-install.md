# dsh-nai-imagegen

DSH 原生插件（Cordis bundle）：**侧栏面板管凭据与默认参数，Agent 工具按需出图，出图落盘后在对话正文里内联显示。**

---

## 它做了什么

| 位置 | 贡献 |
|---|---|
| 侧栏 | 一个「NovelAI 出图」图标；点开是一个配置页：凭据、默认尺寸/模型/步数、目录、试出一张、图生图（选底图 + strength/noise + 宽高）、以及已出图的缩略图墙 |
| Agent 工具 | `nai_generate` / `nai_img2img` / `nai_probe` / `nai_estimate` / `nai_lookup` / `nai_resolve` / `nai_index` / `nai_status` / `nai_config` |
| 对话正文 | `nai_generate` 返回绝对路径，Agent 用 `![](路径)` 在内联显示图片 |
| **代码块按钮** | 正文里**每一个像 NAI 提示词的代码块**都会多出一个「🎨 生图」按钮，点一下直接出图并把结果贴在代码块下面 |
| 本机接口 | `/nai-imagegen/api/*`，只回环，给面板读写配置与图库 |

### 为什么凭据不进浏览器

侧栏那一半**永远拿不到 token**。面板把配置 POST 给宿主半侧，宿主半侧才去调 NovelAI，接口返回的状态里只有「是否已配置」和「来自环境变量还是文件」。浏览器侧既没有免 CORS 的出口，也没有理由持有长期凭据。

### 为什么不需要另外的 LLM

参考项目 `nai-dbgen` 需要自建 LLM 网关，是因为酒馆的模型被对话占用了。在 DSH 里**组装提示词的那个模型就是 Agent 本身**，于是网关、密钥管理、CORS 代理、`<IMG>` 占位协议、正则剥离这些层全部省掉。

---

## 安装

```powershell
# 1) 预演：只打印计划，不动任何文件
node install.mjs

# 2) 写入 profile 清单（会自动备份 package.json）
node install.mjs --apply

# 3) 在 profile 里建立本地链接
cd "$env:DSH_PROFILE_DIR"
pnpm install

# 4) 重启 DSH 进程
```

重启后侧栏会多出图标。

**撤销**：`node install.mjs --uninstall --apply` 然后 `pnpm install`。

### 代理：插件自己会走，不用管

**Node 的 `fetch` 不读 Windows 系统代理**，而 `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` 只在 Node **启动时**读取。插件不能重启宿主，所以**没有依赖启动变量**——它自己实现了一条 `CONNECT` 隧道（`lib/net.js`：裸 socket 做 CONNECT 握手，上面套 TLS，再交给 `node:https`），只用 Node 内建模块。

默认行为（`proxy` 留空）：

| 你的设置 | 插件的做法 |
|---|---|
| 开了 Windows 系统代理 | **自动用它** |
| 没开系统代理 | 直连 |
| `proxy` 填 `off` | 强制直连 |
| `proxy` 填地址 | 用你给的 |

**已实测**（真实账号，清空所有代理环境变量的前提下）：

```
proxy: http://127.0.0.1:7890      ← 自动读出系统代理
probe  ok tier=3  (HTTP 200)
render 1 image in 9.6s  →  V5 · 832x1216 · alpha
```

对照数据（同一台机器）：

| 试法 | 结果 |
|---|---|
| 直连 `image.novelai.net:443` | ✗ 不可达 |
| `fetch` + 只设 `HTTPS_PROXY` | ✗ `fetch failed` |
| `fetch` + 两个变量都设（**启动前**） | ✅ 打通 |
| 运行时改 `process.env.HTTPS_PROXY` | ✗ 无效 |
| **本插件的隧道，零环境变量** | ✅ **打通** |

### 启动脚本（可选）

`launch-with-proxy.cmd` —— 双重点开即可。它从注册表**读出你当前的系统代理**（而不是写死端口），设好两个环境变量，再启动 DSH。插件的隧道不再需要它，但 DSH 里其他基于 Node 的工具仍会受益。

脚本是**纯 ASCII** 的：`cmd.exe` 按 OEM 代码页读 `.cmd`，非 ASCII 字节会乱码甚至破坏解析。

如果它报「Cannot find」，把脚本里的 `EXE` 改成你的 DSH 可执行文件路径。

---

## 第一次使用

1. 侧栏打开 **NovelAI 出图**。
2. 填 **API Token**（NovelAI 账号设置里的 Persistent Token，`pst-` 开头）→ 保存。
   - 也可以不填文件而设环境变量 `NAI_TOKEN`：**环境变量优先**，面板会提示。
3. 按需改默认尺寸/模型/步数。
4. 点 **试出一张** 验证连通。
5. 之后在对话里直接说「出图」或「生成 XX 的立绘」，Agent 会调 `nai_generate`，图片内联在正文。

### 图生图

底图只从**源目录**读（默认 `<outputDir>/../../_in/nai`，可用 `nai_config source_dir` 或面板改）。把 PNG/JPEG/WebP 放进该目录，面板「图生图」区块会列出它们；也可以点 **「从本地选择…」** 调系统文件选择器，选中的图会经回环接口上传并写进源目录后自动选中（重名自动加 `-1`，扩展名按嗅探到的格式强制，超过 3,047,424 px 的图会被拒绝）。

- 选底图 → 填 `strength`（0.01–0.99，越小越贴底图）与 `noise`（0–0.99）→ **宽高必须显式填写**（默认取面板默认值，不会跟随底图尺寸）；
- 单张、像素积 ≤ 1,048,576、≤28 步时 Opus 下 0 Anlas（V5 仍消耗用量电池）；
- 底图本身的上限是 **3,047,424 px 总像素**（超过服务端直接 500），以及 24MB；格式 PNG/JPEG/WebP（WebP 未实测）。

### 建库索引

`nai_lookup` / `nai_resolve` 读的是 `<库名>.jsonl` 索引。首次安装后让 Agent 跑一次 `nai_index`，它会从**源目录**里的原始世界书 JSON 重建索引。同一库有多个历史版本时，**条目最多的那一版胜出**。

---

## 配置字段

配置落在 `$DSH_HOME/nai-imagegen/config.json`，写盘走临时文件 + 重命名，崩溃不会留下半个文档。

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://image.novelai.net` | 接口域名。三种写法都认：裸域名、结尾 `/ai`、以及完整的 `/ai/generate-image` |
| `token` | 空 | Persistent Token。**`NAI_TOKEN` 环境变量优先于它** |
| `model` | `nai-diffusion-5-full` | 模型 id。4.5 / 4 / 3 也都可用，见下节 |
| `width` / `height` | 832 / 1216 | 会**吸附到 64 的倍数**并夹在 64–2048 |
| `steps` | 28 | 1–50 |
| `scale` | 5 | 引导强度 |
| `sampler` | `k_euler_ancestral` | 采样器 |
| `ucPreset` | 3 | 负面预设档位，与官方前端默认一致 |
| `negativePrompt` | 一段通用负面词 | |
| `outputDir` | `<cwd>/_out/nai` | PNG 落点，也是正文内联的来源 |
| `sourceDir` | 空 = `<outputDir>/../../_in/nai` | 图生图可读的底图目录；这是模型可见读盘面的唯一边界 |
| `libraryDir` | `…/文生图用/_pyrite-extract` | 存 `<库名>.jsonl` |
| `librarySourceDir` | `…/文生图用` | 原始世界书 JSON 所在目录 |
| `maxImagesPerCall` | 4 | **计费护栏**：单次调用最多渲染几张 |
| `keepImages` | 500 | 保留张数上限 |

### 计费

`nai_generate` 返回里的「相对消耗」是**形状权重**（面积 × 步数 × 张数，以 832×1216 @28 步为 1），不是价格。Opus 订阅在标准尺寸内不计费、超出才计，所以它给的是可比较的相对值。面板在权重超过 4 时会给黄色提示。

---

## 状态文件

```
$DSH_HOME/nai-imagegen/config.json     配置（含 token；NAI_TOKEN 优先）
<outputDir>/<时间戳>.png               出图
<outputDir>/<时间戳>.json              同批的 prompt / seed / 参数，用于复现
<libraryDir>/<库名>.jsonl              五库索引投影
```

---

## 五库检索的约定

`nai_lookup` 返回的是**原文**，因为库自带一套写法约定，转述会丢信息：

| 写法 | 含义 |
|---|---|
| `a/b/c` | **可选项**，按画面挑一个，不要整串照抄 |
| `a,b,c` | **一组搭配**，按画面取用 |
| `[x]` `[color]` `[部位]` | **占位符，必须替换**。NAI 里 `[tag]` 是**降权**，原样保留会出错 |
| 中文括号内的内容、以 `>` 开头的行 | 用法说明，**不要写进提示词** |

按 `nai_lookup` 的库名：`标签库9.5` 是中→Danbooru 词典，`常规模板5.25` 是服装与人物转化，`扩展库5.4` 是魔物娘 DNA（含**禁止动作**与 Character UC），`同人库8.5` 是角色名册，`SEX模板9.2` 是已验证的场景提示词组合。

---

## 一条硬规矩：不要 import 宿主包

**`link:` 安装的 bundle 不能 `import { defineTool } from '@deepseek-ai/dsh-tools'`。**

这不是猜的，是撞出来的。症状是启动日志里两行：

```
dsh: warning: 1 entry did not activate
nai-imagegen (dsh-nai-imagegen): failed to import
```

真实原因是裸 Node 解析不到宿主包：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
  imported from …/bundle-nai-imagegen/index.js
```

为什么会这样：

- profile 的 `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`，peer 不会被安装；
- profile 的 `node_modules/@deepseek-ai/` 下只有 `cosmokit` 和 `schemastery`，`.pnpm` 里 `@deepseek-ai` 目录数为 **0**；
- 也就是宿主把自己的包留给运行时映射。那个映射对随发行版交付的包有效，但**没接上本包**——即使在已装好的 desktop profile 里，裸 Node 同样解析不到。

**能跑通的写法**：workspace 里既有的那份手写 bundle（`bundle-chat-delete`）**一个宿主包都不 import**，就是为这个。本插件照做：

- [lib/tool.js](lib/tool.js) 自己实现 `defineTool` 的等价物——把参数简写展开成模型看到的 JSON Schema（带 `additionalProperties: false` 与 `required` 数组），并在执行前校验参数。宿主那个 helper 另有 `presentCall` / `projectContent` / `finalizeContent` / `isConcurrencySafe` / `deferLoading` / `timeoutMs` 等展示钩子，本插件用不上，于是**故意不实现**而不是留空壳。
- 于是本包的运行时依赖只剩 Node 内建模块加两个注入的服务（`webServer`、`tools`），真正零外部依赖。
- 验证套件里有一条**回归守卫**专门盯这件事，以后不会再犯。

顺带一个反直觉的点：`dsh.client.inject` **不是**「我 require 了哪些模块」。已装的 `dsh-client-ui-directory-picker-native` 的 bundle 只 require `react`，却声明了两个包——它是**加载顺序依赖**。所以本插件把它依赖的那两个服务提供方（`dsh-client-locale`、`dsh-client-ui-slots`）列在那里是对的。

---

## 代码块上的「生图」按钮

没有哪个 slot 是按代码块渲染的，所以这一半——照 workspace 里 `bundle-chat-delete` 在「没有席位」时的做法——用 `MutationObserver` 扫正文，给**像提示词的**代码块注入按钮，点一下 POST 到本机 `/generate`，结果贴在代码块下面。

**怎么判断「像提示词」**：围栏标了 ` ```nai ` / ` ```prompt ` / ` ```novelai ` **一律认**（这是你的显式开关）；否则文本要像标签表而不像程序——出现 `import` / `function` / `SELECT` / `$` / `git ` 这类源码行直接否决，再要求命中若干 Danbooru 信号（`1girl`、`solo`、`looking at viewer`、`N::tag::`、`char1:`、逗号数量…）。

**两个必须处理的后果**：正文重渲染会丢掉注入的节点，所以结果按**提示词哈希**缓存并在下次扫描时恢复；注入的节点带标记，扫描器会跳过自己产出的 DOM。

测试对分类器有 14 条断言，包括「**要在本对话里那套双子双飞提示词上触发**」和「**要对 JS / PowerShell / JSON / SQL / shell 管道保持安静**」，并且用假 DOM 真跑 `decorate`，断言提示词块长出按钮、代码块什么都不长、重复装饰不重复、注入的标记被跳过。



---

## NovelAI V5 契约（按实测对齐，不是猜的）

请求体是**逐字段对着一次实测过的 V5 调用**写的，因为这里的失败模式既贵又反直觉：

| 事项 | 事实 |
|---|---|
| 模型 id | 默认 **`nai-diffusion-5-full`**（V5，也是你那批「V5测试」库对准的版本）。已知可用：`nai-diffusion-4-5-full` / `-4-full` / `-3`。**本机真实出图的 `Source` 里写着 `NovelAI Diffusion V4.5` 与 `V4`**，所以别把 4.5 当无效值 |
| 接口域名 | **必须 `image.novelai.net`**。旧的 `api.novelai.net` 会回 `400 model must be a valid enum value` —— 看着像你模型名写错，**其实是域名过期**。这条是实测结论，也是唯一被实测确认的那条 |
| **结构化 caption** | V5 **必须**同时带 `v4_prompt` 与 `v4_negative_prompt`。**缺任一个返回的是 `500` 而不是 `400`** —— 看着像服务挂了，其实是请求体 |
| 提示词的三个位置 | 顶级 `input`、`parameters.prompt`、`v4_prompt.caption.base_caption`，**三处都要写** |
| `params_version` | 这套骨架下 4/3/1/0 渲染结果**逐像素一致**（即被忽略）；本插件发 `4` 以对齐官方前端 |
| `Content-Type` | 发 JSON 必须显式设 `application/json`；用 `FormData` 时**不能手设**，否则 `400 missing multipart boundary` |
| 响应形状 | 官方是 `binary/octet-stream` 的 zip（内含 `image_0.png`）；中转站可能是 JSON+base64。两种都解 |
| 401 | 无法区分「token 写错」与「没带 Authorization 头」，所以报错文案明确说了这一点 |
| **429** | 官方 API 文档**明确要求客户端不要重试**，因此**本插件不做任何自动重试**。这不只是合规：一次重试可能在第一次其实已经出图、只是响应丢失时**重复计费** |

### 免费区间（Opus）

**单张、无底图、像素积 ≤ 1,048,576、≤ 28 步** → 不消耗 Anlas。832×1216（积 1,011,712）和 1216×832 都在内。`nai_estimate` 按这个边界逐条判定，并把 `n_samples > 1` 单独点出来。

### `nai_probe`：不烧钱先验一遍

出图前先跑 `nai_probe`（或点面板上的**检测连通性**）。它**不渲染**，而是读 `/user/subscription`：

- `200` → 凭据有效，并回报订阅档位与剩余训练步数；
- `401` → 凭据不可用；
- 网络失败 → 域名或代理写错了。

这样第一次上手不用靠「烧一张试试」来排错。

---

## 画师串（风格库）

那份 `画师串9.28.json` 是 **217 MB / 960 行**，但只有 **96 条**画师串——每行几乎都是参考图的 base64。每条带 `name` / `sequence` / `positivePrompt` / `negativePrompt` / 参考图（832×1216，1.4–1.7 MB）。

导入一次：

```powershell
node import-artists.mjs "C:\Users\14552\Downloads\画师串9.28.json"
```

两个设计决定：

- **不整体解析**。`--max-old-space-size=512` 下 1.1 秒跑完，结束时堆只占 **6 MB** —— 字节级流式扫描，逐条只 `JSON.parse` 那 ~226 KB 的记录。
- **不复制图片**。索引只记每张图在源文件里的**字节区间**（索引 151 KB），插件按需读回来；`/artist-image?id=N` 直接从归档取，实测返回 **1,711,511 字节**的真图。

选中某条后，它的 `positivePrompt` **会前置到每次出图**，`negativePrompt` 并入负向——这才是「风格」，而不是「一段可以复制的文本」。单次调用可用 `artist_id: -1` 临时关掉，或用 `artist_id: N` 临时换一条。

**两个真 bug 就是在这步抓到的**，都只在跨块时暴露，所以回归测试是**分块尺寸 sweep（1 字节 → 8 MB）**：

1. 跨块时把 carry 的字节又扫了一遍，而 `depth` 已经是 2 —— 深度重复累加，边界之后所有记录静默丢失（第一版 960 行只索引出 6 条）。
2. `carry` 借用了复用的 `buffer` 视图，下一轮 `read` 直接改写它 —— 必须 `Buffer.from(...)` 拷出来。

## API Key 池与并发

移植自 `奶龙工具箱/local-apps/novelai-webui/server.js` 的 `class KeyPool`。

**并发度 = 可用 key 数**，这是结构上必然的：`candidates()` 只返回 `active === false` 的 key，`pump()` 循环取用。四把 key 就是四张图同时在画。

| 情况 | 行为 |
|---|---|
| `401` / `403` | 禁用该 key（`invalid` / `forbidden`），任务**换 key 继续** |
| `429` | 该 key 进冷却（指数退避，**认 `Retry-After`**），任务重新入队并**避开它** |
| `408` / `5xx` / 网络 | 同上，退避更短 |
| 其他 | 任务失败，key 标 `unverified` |

**多变体是并行的**：`n_samples: 4` 拆成 **4 个单图作业**丢进池子，而不是一个请求让一把 key 顺次画四张。实测 2 张图**落到了两把不同的 key** 上。

**凭据不进浏览器**：`/keys` 只返回 label + 指纹，token 只写不回显；面板按 id 增删启停，`NAI_TOKEN` 仍覆盖主槽位。

## `<image>` 块格式（「文生图」世界书）

「文生图」世界书让模型按**结构化块**输出，不是裸标签表：

```
<image>
<image_think>
…①~⑦的思考过程…
</image_think>
image###size:832x1216;
Scene:SFW,{1girl},solo.
Middle ground:a gyaru girl leaning back against a graffiti-covered wall…
cowboy shot,front three-quarter view,low-angle,dramatic shadow;
Char1:girl,2::Fujiwara Chika (Kaguya-sama wa Kokurasetai)::,long hair,…sweat|centers:C3;
Char1 UC:feet,shoes,socks,from behind,looking at viewer;
Scene UC:nude,completely nude,nipples,camera;###
</image>
```

把这段原样丢给 NovelAI 只会把 `Scene:` `Char1 UC:` 这些**标签本身画进图里**。`lib/format.js` 把它拆成四样东西：

| 块里的部分 | 去向 |
|---|---|
| `<image>` 壳、`image###…;` 头、字段标签、`;`、`###` | **丢掉** |
| `<image_think>…</image_think>` | **丢掉**（那是模型的思考过程，绝不能发给 API） |
| `size:832x1216` | 变成出图的宽高 |
| `Scene:` + `Char1:` `Char2:`…（按书写顺序） | **正向** |
| `Char1 UC:` `Char2 UC:` + `Scene UC:` | **负向** |

**两个坑**：

1. **字段体是多行的**。上面那个 Scene 跨了三行才出现终止的 `;`——按换行切分会把每条提示词都截断。所以字段是**按标签**切出来的，不是按行。
2. **字段体是变量占位符时**（世界书的示例里就是 `image###{{getvar::尺寸竖图}};`）不能只回退到配置值——占位符名字里的「竖/方/横」就是说朝向。所以会按这个名字把**你配置的尺寸**转成对应朝向，并在结果里说明来源。

`|centers:C3` 会被**从提示词里摘掉**并单独记下来（`C3` 正是 NovelAI 的 5×5 角色位置网格），不会当作文字发出去。**目前它只被捕获和汇报，还没有转成 NovelAI 的 `centers` 载荷字段**——那一步需要再把 Char 拆成 `char_captions`，尚未实现。

**它从三处生效**：`nai_generate` 的 `prompt` 参数可以直接吃整块、`/generate` 路由、以及正文代码块上的「🎨 生图」按钮（分类器认得 `<image>` 和裸 `image###` 信封）。打散在纯标签提示词上的行为**完全不变**。

> 验证：拿世界书里**自带的 19 个真实 `<image>` 块**跑解析，断言没有任何脚手架（标签/头/终止符/占位符/坐标标记）漏进正向或负向；再真机出图，得到的就是那块规范描述的画面。

## 右键：复制图片 / 复制路径 / 另存为

在生成图上**右键**会弹出一个菜单：

| 菜单项 | 做什么 |
|---|---|
| **复制图片** | 把 PNG 写进剪贴板（能直接粘进聊天框、画图软件、文档） |
| **复制文件名** | 只复制 `2026-09-28T15-28-40-804Z.png` |
| **复制完整路径** | 复制绝对路径，便于命令行里直接用 |
| **另存为…** | 触发浏览器下载 |

生效范围是**这个插件自己产出的图**：正文代码块下「🎨 生图」出的结果图、以及侧栏图库里的缩略图。正文里 Agent 用 Markdown 内联的图由聊天渲染器负责，插件碰不到。

**只认自己的图。** 每个由这一半创建的 `<img>` 带 `data-nai-imagegen-image` 标记，document 级的 `contextmenu` 监听器只处理带标记的——否则会劫持整个 app 里所有的图片，那不可接受。测试里两条都断言了：标记的图被接管，未标记的（`closest` 返回 null）**完全不动**。

剪贴板走 `navigator.clipboard.write([new ClipboardItem({'image/png': blob})])`。生成的图本来就是 PNG，所以不需要重编码；万一遇到别的格式才过一遍 canvas。`http://127.0.0.1` 属于安全上下文，Chromium 允许这条 API。

## 体检：`nai_doctor`

> **要生成漫画？先看 [`README-comic.md`](./README-comic.md)。** 那是漫画格式的硬性规范：红线、可复制的 JSON 模板、字段表、报错对照表，以及一段直接贴给模型的**指令块**。文档与解析器之间有契约测试——`tests/verify.mjs` 会把那份模板真跑一遍，并核对报错表里的每条消息确实由解析器产生（且不会许诺一条不存在的）。

这个插件**几乎所有的故障都是静默的**——配置字段被写成错误类型、key 的 id 在保存时被剥掉、重构时掉了一个分支、模块还没加载。它们都不抛异常，只是**悄悄不工作了**，唯一能发现的办法是出一张图然后盯着看。

`nai_doctor` 就是针对这个的：**一次调用，逐项检查每个能力是否完好**，不出图、不烧 Anlas，所以**每次重启后都可以跑一遍**。

```powershell
GET /nai-imagegen/api/doctor      # 或让 Agent 调 nai_doctor
```

真机上是 **39 项**：

| 组 | 检查什么 |
|---|---|
| 配置 | 每个字段的类型（`autoGenerate` 真的是 boolean、`artistId` 真的是 number、`keys` 真的是数组）、没有 null |
| Key 池 | 有可用 key、并发度与可用数一致、**不回传 token** |
| 代理 | 解析出的路径合法，或明确是直连 |
| 画师串 | 索引能加载、有条目、搜索有结果、**记住的那条仍能解析**、参考图能真的从归档读出来 |
| 五个库 | 五个都在、全文检索命中、名册解析命中且**标题不出 undefined**、未命中**不谎报索引为空** |
| 格式解析 | 样例块能解析、尺寸取自块内、**脚手架不漏进正向/负向**、思考过程被丢弃、角色负向成对、坐标被捕获；**简串版不被误判为块、原样放行、内联负权重保留** |
| 浏览器半侧 | 客户端源码里分类器认得 `<image>` 与 `image###`、代码块监听器与右键菜单都装上了、面板三个区块都注册了 |
| 文件系统 | 出图目录可写、包内文件齐全 |

输出一行行 `ok` / `FAIL`，**坏掉的那一项带着原因列出来**，不用猜。

## 稳定性是怎么保住的

除体检之外还有三层**通用防线**（而不只是修一次）：

1. **配置类型往返守卫** —— 遍历配置**当前实际拥有的每个字段**，断言 `save → load → JSON` 后类型不变。**未来新增的字段在加进来的那天就被覆盖**，而不是坏掉的那天。
2. **输入格式矩阵** —— 每种支持的输入形式一条断言（完整块 / 无思考段 / 无信封 / 裸标签表套壳 / 简串版 / 普通标签 / 句中提到 `<image>`），**重构掉一种就红**。
3. **面板渲染 + 字段契约** —— 用桩 React 真跑面板组件；面板从 `/status` 读的字段名逐个断言存在。

> 这三层不是理论：`normalize` 的 boolean 分支、key id 被剥掉、重构掉 `Scene:` 分支、`resolveCharacter` 的 `undefined #154`、`digest` 的误导文案——**每一个都是被这套断言抓出来的**，其中三个是它们上线之前。

## 自动出图开关

面板上的按钮，对应 `autoGenerate`。开启后正文里**像提示词的代码块会自动出图**，不用点「🎨 生图」。

**默认关闭**——它会不问自取地消耗额度。开启后两条约束：每个**不同的**提示词只自动渲染一次（哈希记录，重渲染不会重复花钱），且只有通过分类器的块才参与。

---

## 验证

### 离线断言

```powershell
# 全部离线：不需要凭据、不需要浏览器、不需要重启
node tests/verify.mjs                       # 自包含（自建 zip 夹具）
node tests/verify.mjs <某个.zip>            # 追加「独立实现产出的归档」这一路
```

**真机面板检查**（需要 DSH 正在运行且插件已加载；只读，不出图，不烧 Anlas）：

```powershell
node tests/live-panel.mjs
```

它用**运行中宿主真实返回的** `/status`、`/keys`、`/artists` 去渲染侧栏面板组件，断言每把真 key 的标签与指纹、真实画师串总数与名称、缩略图 URL、输出目录都落到了组件树上，并真的取一张参考图验证是有效 PNG。这是没有浏览器时最接近「打开侧栏看一眼」的证据。

**306 项断言，覆盖十个接缝：**

0. **不 import 宿主包** —— 扫描全部源码（剥掉注释后），断言没有任何 `from '@deepseek-ai/…'` 或 `require('@deepseek-ai/…')`；客户端 bundle 只允许 require `react`。**这条是踩坑之后加的**，理由见下一节。
1. **手写 ZIP 解包器** —— 同时对着**独立实现**产出的归档（Node 生成真 PNG，.NET `ZipArchive` 打包）和**自建**归档验证；并验证非归档输入被拒绝。
2. **客户端 bundle** —— 把 `window.__ModuleLoader__.load` 的 factory 拿桩宿主真跑一遍，断言侧栏行与 `main` 页挂在**同一个 panel id** 下、侧栏行带 `order` 与 `label` 函数。
3. **宿主半侧端到端** —— `apply(ctx)` 挂到桩 `tools` / `webServer` 上，逐条打真实 HTTP 路由；再让 `nai_generate` 指向一个**假 NovelAI 服务端**，跑完整条出图链路：请求构造 → 响应解码 → 落盘 PNG → 写 sidecar → 返回可内联的路径。同时验证「连不上」与「没凭据」都变成干净的工具报错而不是崩溃。
4. **隔离** —— 套件在导入任何模块**之前**把 `DSH_HOME` 重定向到临时目录。断言不是「真实目录不存在」（插件装好后它本就该存在），而是**真实的状态文件在套件前后逐字节相同**。早期版本把配置写进了真实 home，所以这条是补的。
5. **NovelAI 响应解码** —— 官方端点是 `binary/octet-stream` 的 zip，中转站可能回 JSON+base64，而两者都可能谎报 content-type，所以解码靠**嗅探字节**而不是信 header。覆盖 zip / PNG / JPEG / 五种 JSON 信封形状 / `data:` URL / 谎报 content-type，以及「JSON 里没有图片」与「JSON 解析不了」都必须**明确报错而不是静默成功**。
6. **PNG 溯源** —— 真实出图把种子放在 `Comment` 的 **JSON** 里（`{"seed": 2350067352, …}`），并带 `Software: NovelAI` 与 `Source: NovelAI Diffusion V4.5 4BDE2A90`。测试用的夹具是**照真实文件的 chunk 布局**造的，并断言 sidecar 里记的种子/模型/尺寸是**从图里读回来的**而不是抄请求参数。
7. **代理隧道** —— 起了两个桩服务（一个明文 HTTP 源站、一个真 CONNECT 代理），验证 `httpRequest` 经隧道拿到源站响应、CONNECT 的目标正确、POST 也可用、直连时不碰代理；并验证**代理拒绝 CONNECT** 与**代理不可达**都变成明确报错而不是挂住。
8. **代码块分类器** —— 14 条断言：要在真实提示词（含本对话那套双子双飞）上触发，要对 JS / PowerShell / JSON / SQL / shell 管道保持安静；再用假 DOM 真跑 `decorate`，验证提示词块长出按钮、代码块什么都不长、重复装饰不重复、注入标记被跳过。
9. **面板渲染** —— 用桩 React 真跑整个面板组件（18 项）：Key 池的标签/指纹/停用行/启用按钮/已完成数/tier/内联报错、并发度与队列深度、画师串区块与缩略图 URL、自动出图开关的开与关两态、以及「无 key 无画师串」的空状态不崩。
10. **自动出图边界** —— 关着不渲染；打开时**只渲染最新那一个**（倒序扫描让额度落在用户正在看的块上）；之后的扫描补上其余；**单会话 12 张封顶**；超预算的块保留按钮等手动点。这组断言抓出过一个「读起来完全合理但完全无效」的修复。

> 还有一个**面板/宿主字段契约**测试：面板从 `/status` 读的 31 个字段名逐个断言必须存在，并断言 `/status` 与 `/keys` 都不含 `pst-`。字段改名会让整个区块变空白且**任何地方都不报错**，所以这条不能靠截图。

> 面板地址 key 的往返也在断言内：`/keys/add` 返回的 id 必须与磁盘上的一致，`/keys/update` 必须真的改到那一把，`/keys/remove` 必须真的删掉那一把。**id 在配置往返中被剥掉过一次**，那会让三个按钮全部静默失效。

> 测试抓到过两个真问题：
>
> - `client.js` 里用了 `module.exports` / `exports` 却**没先声明模块记录**——浏览器里直接抛。DSH 的 factory 协议要求自建 `var module = { exports: {} }; var exports = module.exports`。
> - `safeJoin` 起初对 `..\..\x.png` 是**静默改名**成 `x.png` 而不是拒绝。虽然结果仍在目录内（不算漏洞），但安全边界不该猜——现在显式抛错，并保留解析后再校验兜底。

### 组合验证（不用重启）

桌面 profile 被 Electron 独占，CLI 不碰它。要在**不重启**的前提下确认 bundle 能被正确组合，用一次性 profile：

```powershell
# 1) 从出厂模板造一个一次性 profile，只 dump 配置
dsh zz-nai-verify --from-default-profile web --dump-config

# 2) 把本插件装进去（环境变量覆盖目标 profile）
$env:DSH_PROFILE='zz-nai-verify'; $env:DSH_PROFILE_DIR="$env:DSH_HOME\profiles\zz-nai-verify"
node <本目录>\install.mjs --apply
cd "$env:DSH_PROFILE_DIR"; pnpm install

# 3) 组合并查我们的行
dsh --profile zz-nai-verify --dump-config | Select-String nai-imagegen

# 4) 用完删掉
Remove-Item "$env:DSH_HOME\profiles\zz-nai-verify" -Recurse -Force
```

已实测通过：组合输出 1249 行、`RC=0`、末尾出现

```yaml
# == dsh-nai-imagegen
- id: nai-imagegen
  name: dsh-nai-imagegen
```

这证明 `package.json` 的 `dsh.bundle.patch` 被采纳、`cordis.patch.yml` 能解析、插件行被插进组合树正确的一层。

### 真机连测试（会花额度，默认不跑）

```powershell
$env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:NAI_TOKEN='pst-…'
node tests/live-smoke.mjs [输出目录]
```

它跑插件自己的代码，不 mock：探针 → 出一张 832×1216 @28 步（Opus 免费区间）→ 探针。凭据只从环境读，**不打印、不落盘**。

**已实测通过**（真实账号，tier 3 / Opus）：

```
probe            ok  tier=3  usage=66%  (HTTP 200)
render           1 image in 11.3s, PNG signature 89504e470d0a1a0a
provenance       software=NovelAI  model=NovelAI Diffusion V5 0ADF9AB7
                 seed=2823492654  steps=28  832x1216
IHDR             colourType=6  (truecolour with alpha → 透明底成立)
Anlas 变化        训练步数 0 → 0，delta 0（落在免费区间，未消耗）
```

这一跑同时验证了：V5 请求体被接受、手写 ZIP 解包正确、PNG 溯源读取正确、**透明底真的带 alpha**、以及免费区间护栏有效。

### 完整激活验证（隔离 DSH_HOME）

`--dump-config` 只证明「会被组合」，不证明「能加载」。要一次验到底——模块能解析、`apply()` 真跑、路由真监听、客户端 bundle 真被服务——把整个 DSH 在一个**隔离的 DSH_HOME** 里启动一遍（不碰你的桌面应用、不占它的端口）：

```powershell
$tmp = "$env:TEMP\nai-verify-home"
$env:DSH_HOME = $tmp
dsh zz-web --from-default-profile web --dump-config      # 建一次性 profile
$env:DSH_PROFILE_DIR = "$tmp\profiles\zz-web"
node <本目录>\install.mjs --apply
cd $env:DSH_PROFILE_DIR; pnpm install
dsh zz-web --no-open --port 3080                          # 后台启动
```

启动后逐项探：

```powershell
# 1) 宿主半侧：路由在服务，五个库都认出来了
Invoke-WebRequest http://127.0.0.1:3080/nai-imagegen/api/status -UseBasicParsing
# 2) 客户端半侧：启动载荷的 plugins/?? combo 列表里有没有我们
(Invoke-WebRequest "http://127.0.0.1:3080/?token=<启动行里的 token>" -UseBasicParsing).Content -match 'dsh-nai-imagegen/client.js'
```

**已实测通过**（DSH 0.1.7-rc.2）：启动日志**零警告**；`GET /nai-imagegen/api/status` → `200`，五个库条目数 `195 / 251 / 58 / 455 / 992` 全对；启动载荷的 combo 列表含 `dsh-nai-imagegen/client.js`；那个 10.8 MB 的组合客户端 bundle 里确实带着我们的模块 id、`sidebar.panellist` 席位注册与 `"main"` 主面板注册。

验完把隔离 home 删掉即可，你的真实 `$DSH_HOME` 全程未被触碰。

---

## 结构

```
index.js           宿主半侧：注册 15 个 nai_* 工具 + /nai-imagegen/api 路由
client.js          浏览器半侧：手写预构建 CJS bundle（无构建步骤）
cordis.patch.yml   bundle 自己声明的一行插件
install.mjs        安装器（默认 dry-run）
lib/config.js      配置读写
lib/character-edit.js  用提示词模型改写角色特征（固定特征 / 可选服装 / 关键字 / 负面）
lib/dsh-go.js      DSH Go（Android）原生界面：工具卡、状态条、原生面板
lib/nai.js         NovelAI API 客户端 + 零依赖 ZIP 解包 + 种子读取
lib/library.js     五库索引：检索 / 角色解析 / 重建
lib/tool.js        本地的 defineTool 等价实现，见下一节
lib/util.js        纯函数（digest、路径收敛）
tests/verify.mjs   122 项离线断言（含桩宿主与假 NovelAI 服务端）
```

**零外部依赖**：只有 Node 内建模块 + 两个注入的 DSH 服务（`webServer`、`tools`）。所以 `link:` 安装不下载、不构建，也没有版本兼容检查的负担。

---

## 排错

| 现象 | 原因 |
|---|---|
| 侧栏没有图标 | bundle 没装成。确认 profile `package.json` 的 `dependencies` 有 `link:` 项、`dsh.profile.bundles` 里有它，且 `pnpm install` 跑过、DSH 重启过 |
| 启动日志 `failed to import` | 你的包 import 了宿主包。见上面「一条硬规矩」——`link:` 包解析不到 `@deepseek-ai/*` |
| 面板显示「未配置凭据」但文件里填了 | `NAI_TOKEN` 环境变量在生效，它优先 |
| `nai_lookup` 说索引为空 | 没跑 `nai_index`，或 `librarySourceDir` 指错 |
| 出图 `400` | 模型 id 不是有效枚举值，或域名过期（要 `image.novelai.net`）。文案里带原文 |
| 出图 `500` | **几乎一定是请求体**：V4/V5 缺了 `v4_prompt` 或 `v4_negative_prompt`。不是服务故障 |
| 出图 `401` | 凭据无效。401 无法区分「token 写错」与「没带头」，先检查 token 完整性 |
| 出图 `429` | 触发限流。官方要求**不要重试**，等一会儿手动再来 |
| 面板白屏 | 浏览器控制台看 bundle 加载错误；`dsh.client` 的 `inject` 列出的模块必须能解析 |
| 想知道会不会花钱 | 先跑 `nai_probe`（不渲染），再用 `nai_estimate` 看是否落在免费区间 |
