## dsh-nai-imagegen v0.6.0

### 生图请求链路调整

对照 nai-dbgen 与 st-chatu8 的请求实现，补了三点：

- **单次请求总时限**（`requestTimeoutMs`，默认 5 分钟）：空闲超时管不到「慢速滴流」的中转，总时限兜底。
- **V5 `use_new_shared_trial`**（`useNewSharedTrial`，默认开）：对齐官方客户端和 st-chatu8 的 V5 请求。
- **URL 候选回退**：baseUrl 带自定义路径时先试标准路径，404/405 再试原始地址；连接阶段失败也可换候选。只在未触达模型时回退，不会造成重复计费。

### 安装

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<克隆后的绝对路径>"
```

DSH Go：把仓库放到手机的 `/root/.dsh/dsh-go/plugins/`，重启引擎。

### 分享版（附件）

`dsh-nai-imagegen-friend-v0.6.0.zip`：只有插件本体 + 安装说明，不含任何 token、画师串或角色数据。

### 验证

- 61 项离线测试（新增：V5 共享试用标记、配置默认值、总时限、URL 候选）
- 无运行时依赖，Node.js 22.19+
- 许可证：MIT
