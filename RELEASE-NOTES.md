## dsh-nai-imagegen v0.9.3

### 修复：工具调用现在是真调用

- 以前「工具调用输出」只是让模型在文本里回一段 JSON，模型不一定照做，所以常常“没效果”。
- 现在会把 `submit_caption` 的函数工具（JSON Schema）通过 `tools` 传给 DSH 的 llm 服务，并解析流里的 `tool-call-delta` / `tool-call`，直接拿函数参数生成 caption。
- 只返回工具调用、没有文本的响应不再被当成空回复。
- 不支持工具调用的模型仍会退回提示词 JSON 的方式。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.9.3.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 69 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
