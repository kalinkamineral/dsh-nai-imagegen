## dsh-nai-imagegen v0.7.1

这一版合并了手机端做的优化，重点是 DSH Go 原生图库和网页插件页。

### 修复

- **原生图库不出图**：App 上报的 `components` 是空列表，旧逻辑据此判定「不支持 gallery」并整段关闭；现在空列表按「未上报」处理，只有明确列出且不含 `gallery` 时才退回文字列表。面板自身对表单的判断也同步修正。
- **`assets/` 必须随包存在**：桥接在解析清单时就检查 `dshGo.assets`，缺目录会让所有 `asset:` 图片 404；随包提供 `assets/.keep`。
- **网页插件页没有样式**：样式表改为 `apply()` 时注入，`main` 槽位的页面不再是无样式文字。
- **`seed` 等 `undefined` 让出图调用整体失败**：返回值里的 `seed` / `strength` / `noise` 等统一兜底为 `null`。
- **自动清理误删共享目录的 PNG**：只删本插件命名的 `时间戳.png`。
- **出图前不建输出目录**：渲染前 `mkdir -p`。
- **图库格子点不开**：去掉格子动作，点按即可打开查看器。

### 新增

- 原生面板：角色库（点一下把 DNA 写进提示词）、画师串搜索、作品缩略图与原图副本（App 查看器可保存到相册）、图库顶部最新作品大图。
- 场景提示词与角色提示词分开（每行一个角色，走结构化 caption）。
- 提示词输入上限提高到 2000 字。
- 网页大图查看器：blob 下载、底部「关闭」、`100dvh` 自适应。

### 变更

- 接口地址留空时回落官方 `https://image.novelai.net`。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.7.1.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据；`assets/thumbs`、`assets/full` 这类用户作品预览也不会打进包里。

### 验证

- 64 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
