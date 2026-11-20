## dsh-nai-imagegen v0.9.8

### WebP 也能读图了

官网出图一直同时提供 PNG 和 WebP，两种格式带的生成记录完整度相同——但插件此前只认 PNG，遇到 WebP 在文件头就被拒绝。现在四种来源按可信度依次尝试：

1. PNG 文本块（`Software` / `Source` / `Comment`）
2. PNG alpha 通道隐写（`stealth_pngcomp`，文本块被工具清掉时仍可读）
3. **WebP EXIF**（本次新增）
4. **JPEG App1/Exif**（本次新增）

WebP 的记录不在文本块里，而在 `EXIF` 的 `UserComment` 标签：`ASCII\0\0\0` + 一层外层 JSON（`Title / Description / Software / Source / Comment`），`Comment` 键内才是和 PNG 相同的那条内层 JSON；`ImageDescription` 与 `Software`（含模型哈希）同样可用。

### 读图窗口接受三种格式

文件选择器从 `image/png` 改为 PNG / WebP / JPEG，拖进来的参考图判断也从 `\.png$` 放宽；读图栏顶部显示实际格式，报错文案按容器区分。

**`nai_read_png` 改名为 `nai_read_image`**：它现在读三种格式，旧名字会误导。参数与返回字段不变，只新增 `container`（`png` / `webp` / `jpeg`）。

### 实测

以一张 832×1216 的 V4.5 WebP：

- 读出的 seed、sampler、steps、scale、cfg_rescale、尺寸与 PNG 记录完全一致；
- 只凭记录复现（不加画师串 / UC 预设 / 质量词），结果与原图**逐像素相同**（`identical: True`）。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.9.8.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 85 项离线测试（`npm run verify`），本次新增 5 项：WebP EXIF 读取、JPEG EXIF 读取、无记录 WebP 的报错文案、WebP 与 PNG 记录产生相同的 replay、`/png-meta` 接受 WebP 上传
- 已知遗留：`POST /generate accepts the panel vibe list…` 一例在无 API Key 的测试环境里会失败（渲染前先因 Key 池为空报错），与本次改动无关，此前即如此
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
