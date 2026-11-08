## dsh-nai-imagegen v0.9.0

### 提示词预设：消息段编辑器

预设从「system + user 两段」改成 preset-plus 那种**段列表**：

- 每段可设：段名、角色（系统 / 用户 / 助手）、启用、工作台专用、内容；
- 每段可上移 / 下移 / 在上方插入 / 在下方插入 / 删除；
- 写词按段顺序组装成 system + 多条 user/assistant 消息；
- 「工作台专用」的段不进 `nai_write_prompt` 工具调用；
- 旧版预设文件自动迁移。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.9.0.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 67 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
