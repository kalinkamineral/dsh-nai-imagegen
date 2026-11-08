## dsh-nai-imagegen v0.9.5

### 提示词 → 工具调用工作流

- 新增 `docs/prompt-tool-workflow.md`：变量注入 → 预设段组装 → 工具契约 → 解析 → 校验 → 回填/出图，含两种模式选择、失败重试与验证方式。
- `submit_caption` 工具的描述与字段说明补全：英文标签、scene/char 分工、≤6 角色、坐标规则，工具模式只靠 schema 也能写对。
- 预设「预览当前预设」现在同时显示工具 schema（工具模式开启时）。
- `nai_write_prompt` 输出末尾标注使用的预设名。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.9.5.zip`：只有插件本体 + 安装说明，不含任何 token、画师串、作品预览。

### 验证

- 69 项离线测试（`npm run verify`）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
