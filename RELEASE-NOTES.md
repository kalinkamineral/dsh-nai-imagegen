## dsh-nai-imagegen v0.5.0

### 变更

- **DSH Go 原生面板重做为侧栏同构的 5 页签**：创作 / 编辑 / 图库 / 资料库 / 设置，一个面板完成原来分散的入口。
- **网页版插件页位置改用同一套侧栏布局**：插件页居中限宽，两处不再两套前端。
- 蒙版重绘（局部重绘的笔刷）在原生端不可实现，编辑页里保留说明并指向网页版。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎后在「插件」页签打开面板。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.5.0.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据。

### 验证

- 57 项离线测试（`node tests/verify.mjs`），GitHub Actions 每次推送自动跑
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
