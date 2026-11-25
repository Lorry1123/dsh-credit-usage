# dsh-credit-usage

A DeepSeek Harness (DSH) plugin that shows the weekly Codex and Claude limits and the DeepSeek balance in the DSH sidebar.

在 DSH 左侧导航底部（「设置」上方）显示 Codex、Claude 的周剩余额度和 DeepSeek 余额。只读查询，不发起模型对话；收起侧栏时隐藏。

## 数据来源

| 项目 | 读取方式 |
| --- | --- |
| Codex 周剩余 | 启动本机 `codex app-server --stdio`，调用 `account/rateLimits/read`，取 7 天窗口的 `usedPercent` 与重置时间 |
| Claude 周剩余 | 在伪终端中启动 Claude Code（禁用 hooks、MCP、工具），发送 `/usage`，解析 `Current week (all models)` 的已用百分比 |
| DeepSeek 余额 | 已登录 DSH 账号时读取账号余额（含充值与赠金）；否则使用凭据引用 `DEEPSEEK_API_KEY`（或同名环境变量）请求 `https://api.deepseek.com/user/balance` |

复用本机 Codex、Claude Code 和 DSH 的现有登录，插件本身不保存任何凭据。成功结果缓存 4 分钟，失败 1 分钟后重试；DeepSeek 凭据变更时立即失效缓存。

## 结构

- `index.js` — 服务端：注册 `GET /api/dsh-credit-usage?provider=codex|claude|deepseek`，带缓存与超时
- `cli-usage.js` — Codex / Claude CLI 的读取与解析
- `balance.js` — DeepSeek 余额读取与多币种十进制求和（CNY、USD）
- `client.js` — Web 端侧栏组件
- `locale/` — 中英文元信息
- `cordis.patch.yml` — bundle 安装时插入的插件配置

## 配置

| 字段 | 说明 |
| --- | --- |
| `claudeWslDistro` | Windows 上通过 WSL 运行 Claude Code 时的发行版名，如 `Ubuntu-22.04` |
| `claudeWslCwd` | WSL 内 Claude Code 的工作目录（绝对路径）；设置后在 Windows 上走 WSL |
| `claudeCwd` | 非 WSL 模式下 Claude Code 的工作目录，默认用户主目录 |

`cordis.patch.yml` 中的 `claudeWslCwd` 是占位符，使用前请改成自己的发行版和目录（该目录需已在 Claude Code 中确认信任，否则会显示「终端需初始化」）。

## 要求

- DSH `0.2.2-rc.5`（见 `package.json` 的 `engines.dsh`）
- 需要显示的项对应的 CLI 已安装并登录：`codex`、`claude`

## 测试

```sh
pnpm test
```
