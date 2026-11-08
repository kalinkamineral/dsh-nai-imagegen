## dsh-nai-imagegen v0.9.2

### 变更

- 去掉提示词预设段的「工作台专用」开关。写词本来就是工作台场景，这个开关没有实际区分；旧预设文件里的该字段会被忽略。
- 段编辑现在只有：段名、角色、启用、内容，以及上移/下移/上下插入/删除。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.9.2.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 68 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
