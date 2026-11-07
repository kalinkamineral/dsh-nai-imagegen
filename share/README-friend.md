# dsh-nai-imagegen · 分享版

一个给 DeepSeek Harness（DSH）用的 NovelAI 出图插件：侧栏面板 + 一组 `nai_*` 工具，
支持文生图、图生图、局部重绘、导演工具，以及角色 DNA、画师串、提示词改写。

这个分享版**不包含**作者的 API Key、画师串库、角色库和作品库——第一次使用时自己填接口地址和 token 即可。

## 包里有什么

```
plugin/dsh-nai-imagegen/   插件本体（含 DSH Go 原生工具卡/面板适配）
README-分享版.md           本文件
```

## 安装

要求：DSH 0.2.1 及以上，Node.js 22.19+。

### 桌面版 DSH

1. 把 `plugin/dsh-nai-imagegen` 整个文件夹放到一个固定位置（例如 `~/.dsh/local-bundles/dsh-nai-imagegen`）。
2. 打开终端执行：

```sh
dsh plugin --profile desktop add "<插件文件夹的绝对路径>"
```

3. 重启 DSH（或重启 `dsh web`）。

> 插件是「链接安装」：文件夹要保留，删了插件就起不来。

### DSH Go（Android）

1. 把 `plugin/dsh-nai-imagegen` 放到手机的下载目录，然后在 App「终端」（本机 Linux 环境）里：

```sh
mkdir -p /root/.dsh/dsh-go/plugins
cp -R /sdcard/Download/dsh-nai-imagegen /root/.dsh/dsh-go/plugins/
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-nai-imagegen
```

2. 回 App「引擎」页重启引擎。装好后工具卡、输入框上方的余额状态条和 NovelAI 面板都能用。

## 第一次配置

打开 DSH 右侧栏的 NovelAI 页签 → 设置：

1. **接口地址**：填你的 NovelAI 地址。直连官方填 `https://image.novelai.net`；国内一般填你的中转站地址（例如 `https://nai.nailong.win`）。
2. **API Key**：填 NovelAI 的 Persistent Token（`pst-` 开头，在 NovelAI 账号设置里生成）。多个 key 可以加到 Key 池，每个 key 多一个并发出图位。
3. 点保存。然后点「刷新余额」或让 agent 跑 `nai_probe`，返回 200 就说明通了。

## 功能

- **出图**：提示词、尺寸、步数、模型、画师串、UC 预设、seed、多张
- **解码**：默认 JSON（与 nai-dbgen 的「自动」同路径），可在设置里切 ZIP（体积最小）或自动
- **图生图 / 局部重绘 / 导演工具**（线稿、草图、上色、表情、去杂物）
- **角色库**：固定特征（DNA）、可选服装、关键字、角色参考图；「用提示词改特征」
- **画师串**：导入画师串 JSON、搜索、预览、单独覆盖
- **写提示词**：用 DSH 的模型把一句话/参考图写成 NovelAI 提示词
- **日志**：每次写词、出图、连接测试都有记录，含耗时与下载字节数（排查慢图用）
- **DSH Go**：原生生图工作台（表单直接出图、AI 写词、实时进度、取消）、输入框「AI 写词」胶囊、工具卡、余额状态条

## 已移除

- 按模式覆盖（出图 / 漫画各一套设置）——现在只有一套共享默认值，旧配置里的 `modes` 会被忽略。
- 悬浮窗（可拖拽的按模式设置窗口）。

## 自查

```sh
cd plugin/dsh-nai-imagegen
npm run verify
```

离线跑，不联网、不出图。装好后也可以让 agent 运行 `nai_doctor` 检查各项能力。
