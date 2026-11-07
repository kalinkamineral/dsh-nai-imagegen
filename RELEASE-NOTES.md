## dsh-nai-imagegen v0.5.1

### 变更

- 插件页位置改为**自适应布局**：窄窗口等同于侧栏单栏；≥1100px 放宽容器并把参数网格加到 3 列；≥1440px 加到 4 列；宽屏导航靠左紧凑排列。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.5.1.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据。

### 验证

- 57 项离线测试，GitHub Actions 每次推送自动跑
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
