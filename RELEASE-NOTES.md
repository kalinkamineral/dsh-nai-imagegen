## dsh-nai-imagegen v0.2.0

### 新增

- **DSH Go 原生生图工作台**（`novelai-studio` 面板）：在手机上手填提示词与参数直接出图，
  面板实时显示耗时、已收字节，完成后列出文件并可复制路径，支持取消。
- 老版本 App 缺少表单组件时自动降级为 v1 提示，不画灰色占位。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎后在「插件」页签里打开「生图工作台」。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.2.0.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据。

### 验证

- 51 项离线测试（`node tests/verify.mjs`），GitHub Actions 每次推送自动跑
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
