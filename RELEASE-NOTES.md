## dsh-nai-imagegen v0.4.0

### 新增

- **输入框胶囊「AI 写词」**：在聊天输入框写一句描述，点胶囊直接带进工作台并打开，再点「AI 写词」即可回填提示词。
- **工具 `nai_write_prompt`**：在对话里让 Agent 把一句话写成结构化提示词（含角色标签），不出图，可与 `nai_generate` 接力。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎；工作台在「插件」页签，胶囊在输入框上方。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.4.0.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据。

### 验证

- 55 项离线测试（`node tests/verify.mjs`），GitHub Actions 每次推送自动跑
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
