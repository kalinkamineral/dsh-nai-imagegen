## dsh-nai-imagegen v0.1.0

DeepSeek Harness（DSH）的 NovelAI 出图插件首个正式发布版。

### 包含

- 文生图 / 图生图 / 局部重绘 / 导演工具
- 角色库（DNA）、画师串、写提示词、Key 池
- 角色特征「用提示词改写」
- DSH Go（Android）原生工具卡、余额状态条与原生面板
- 出图进度（已接收字节 / 总大小）与渲染日志（TTFB、字节数）
- 解码选项：json（默认）/ zip / auto

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，再 `dsh plugin --profile web add …`。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.1.0.zip`：只有插件本体 + 安装说明，**不含**任何 token、画师串或角色数据。
朋友装上后自己在侧栏填「接口地址 + Token」即可。

### 验证

- 47 项离线测试（`node tests/verify.mjs`），GitHub Actions 每次推送自动跑
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
