## dsh-nai-imagegen v0.9.1

### 新增

- 「提示词预设」新增**「新建预设」**：一键创建空白自定义预设（带一个可编辑的空段），建完立即成为当前预设，可以直接改段名、角色和内容。
- 写词时会跳过空段，空白预设不会把空消息发给模型。

### 版本节奏

- 预设相关的小改动从 0.9.1 起按 0.9.x 递增，不再每次跳大版本。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.9.1.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 68 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
