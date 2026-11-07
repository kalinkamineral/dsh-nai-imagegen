## dsh-nai-imagegen v0.6.1

### 修复

- **测试日志污染**：`npm run verify` 之前把测试用的故意失败写进真实出图日志，面板因此显示一堆假的「出图失败」。现已用 `tests/run.mjs` 把 `DSH_HOME` 隔离到临时目录，并附带 `scripts/clean-test-log.py` 清理历史噪音（自动备份）。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.6.1.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据。

### 验证

- 61 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
