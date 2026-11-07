## dsh-nai-imagegen v0.3.0

### 新增

- **DSH Go 工作台内嵌「AI 写词」**：在手机面板里写一句描述，直接调写词模型生成结构化提示词并回填到表单，可取消。
- 回填规则与网页版一致：基础 caption 替换提示词，负面追加，角色正面/负面分别拼进提示词与负面提示词。
- 写词失败按原因给出提示：模型拒绝、格式不合格、无可用模型、已取消。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎后在「插件」页签打开「生图工作台」。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.3.0.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据。

### 验证

- 53 项离线测试（`node tests/verify.mjs`），GitHub Actions 每次推送自动跑
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
