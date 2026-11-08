## dsh-nai-imagegen v0.9.4

### 怎么确认预设真的生效了

- **预览**：设置 → 提示词预设 → 选中预设 → 「预览当前预设」，直接看到本次会发送的 system 与 user/assistant 消息。
- **日志**：写词记录里新增 `preset: { kind, id, name, builtin }`，成功摘要会写「预设「X」」；`GET /logs` 或面板日志页可直接核对。
- **接口返回值**：`POST /write` 返回 `preset`。
- 手工编辑 `presets.json` 后无需重启，文件 mtime 变化会自动重载。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.9.4.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 69 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
