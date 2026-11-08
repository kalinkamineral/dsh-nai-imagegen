## dsh-nai-imagegen v0.8.0

### 提示词预设重做（参考 dsh-preset-plus）

「设置 → 提示词预设」从单套可改文本改成**命名预设**：

- 写词 / DNA 各自一组预设，当前选中项随时切换；
- 内置预设随插件更新且只读，编辑后保存会自动另存为自定义预设；
- 支持复制为自定义、删除、恢复内置、整套导出 / 导入 JSON；
- 旧版单预设文件自动迁移为「我的预设（迁移）」。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.8.0.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 67 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
