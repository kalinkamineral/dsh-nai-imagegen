## dsh-nai-imagegen v0.7.0

### 写提示词：范围与输出通道

对照 st-chatu8 与 nai-dbgen 的写法，补了两个可开关的写词选项（面板「设置 → 写提示词」或 `nai_config`）：

- **成人向创作范围**（`writerAdult`，默认关）：写词 system 里如实说明这是成年人之间的虚构插画、角色均为成年人、输出标签而非叙述；开启后模型拒绝会自动重试一次。
- **工具调用输出**（`writerToolCall`，默认关）：只允许模型回一个 `{"tool":"submit_caption","arguments":{…}}`，插件再摊平成原有字段，照顾更听工具格式的模型。

没有采用伪造「系统接管/审计通过」的越狱文本：那是靠欺骗模型换来的行为，换模型不可预期。范围说明是如实声明，不是伪装。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.7.0.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据。

### 验证

- 63 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
