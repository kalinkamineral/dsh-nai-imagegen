## dsh-nai-imagegen v0.7.2

### 新增

- **「描述画面」旁的按次开关**：写词栏新增「工具调用」「破限」两个勾选项，默认跟随设置，只影响当前这次写词；DSH Go 面板同样加了这两个开关。
- 接口与工具支持按次覆盖：`POST /write` 接受 `toolCall` / `adult`，`nai_write_prompt` 接受 `tool_call` / `adult`；省略时用设置里的默认值。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.7.2.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 64 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
