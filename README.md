# qq-mcp

让 AI 用**你自己的 QQ 号**做事的 MCP 服务器：读消息、发消息、管群、操作 QQ 空间。260 个工具，一个 Docker 容器，能直接部署到云上（Streamable HTTP），掉线会自动重新登录。

An MCP server that drives your own QQ account — messages, groups, files and QQ空间 (Qzone) — 260 tools, one container, cloud-ready over Streamable HTTP, with automatic re-login.

> ⚠️ 用自动化程序操作个人 QQ 违反腾讯用户协议，账号可能被限制。风险自负，请只用于自己的账号。
> Automating a personal QQ account is against Tencent's terms and can get it restricted. Use at your own risk, on your own account only.

## 能做什么

| 类别 | 工具举例 |
| --- | --- |
| 聊天 | `find_contact` 按名字找人/群 · `read_chat` · `search_chat` · `send_text`（支持 @、引用、表情） · `send_image` / `send_voice` / `send_video` / `send_file` · `reply_to_message` · `forward_messages` 合并转发 · `poke` · `view_image`（让 AI 看图） |
| 实时 | `get_unread` · `list_recent_chats` · `wait_for_message` · `get_events`（撤回、入群、好友申请…） |
| 群 | 成员列表、禁言、踢人、管理员、群名片、头衔、群公告、群文件、群相册、精华、群待办、加群申请… |
| QQ 空间 | 发说说（带图、可见范围）、删说说、点赞、评论/回复、转发、好友动态、访客、留言板（读/写/回复/删）、相册与照片、点赞名单、浏览/点赞数、亲密度 |
| 兜底 | `onebot_call` 调任意 OneBot 动作 · `qzone_request` 带登录态调任意 QQ 空间接口 |

`node dist/index.js tools` 列出全部工具；`QQ_TOOLSETS` / `QQ_READ_ONLY` 可以只开放一部分。

## 原理

容器里跑一个**官方原版 Linux QQ**（虚拟显示器上），[SnowLuma](https://github.com/TomyJan/SnowLuma) 把它变成 OneBot v11 接口，本项目再把每个动作变成 MCP 工具，并加上聊天便捷工具、QQ 空间扩展、扫码登录和登录守护。

几个现成方案没有解决的点：

- **不需要任何特权**：SnowLuma 用 ptrace 注入 QQ，而大多数云平台（`ptrace_scope=1`）只允许追踪子进程。这里由 SnowLuma 的运行时进程亲自拉起 QQ（`docker/qq-launcher.mjs`），所以在 Railway 这类平台上也能注入。
- **扫码登录走 MCP 或网页**：`qq_login` 返回登录窗口截图；`/login/<token>` 是一个实时刷新的二维码页面。
- **登录守护**：每 30 秒检查一次——记住的账号自动点「登录」、自动关掉下线弹窗、接口卡死就重启 QQ；只有真的需要扫码时才通过 `NOTIFY_WEBHOOK` 通知你。

## 部署

### Docker

```bash
docker build -t qq-mcp .
docker run -d --name qq-mcp --shm-size=1g \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 24) \
  -v qq-data:/data -p 8000:8000 qq-mcp
```

MCP 地址（Streamable HTTP）：`http://<host>:8000/mcp/<MCP_AUTH_TOKEN>`，或 `/mcp` 加 `Authorization: Bearer <token>`。
打开 `http://<host>:8000/login/<MCP_AUTH_TOKEN>`，用手机 QQ 扫码。登录状态保存在 `/data`，重启后自动登录。

### Railway

从这个仓库部署（Dockerfile），挂一个卷到 `/data`，设置 `MCP_AUTH_TOKEN`（至少 24 位随机字符），生成域名即可。`railway.json` 已配置健康检查。
提示：一个 QQ 客户端约占 1GB 内存。

### QQ 客户端来源

腾讯的下载服务器拒绝大多数境外 IP，所以默认从公开镜像 `linyuchen/pmhq` 里复制未修改的 `/opt/QQ`（QQ 3.2.34）。在国内构建可以直接用官方安装包：

```bash
docker build --build-arg QQ_DEB_URL=<https://im.qq.com/linuxqq/ 上的 .deb 链接> -t qq-mcp .
```

## 配置（环境变量）

| 变量 | 说明 |
| --- | --- |
| `MCP_AUTH_TOKEN` | 必填，访问令牌 |
| `NOTIFY_WEBHOOK` | 需要扫码时发通知：Discord webhook、含 `{text}` 的 URL（Bark、Server酱…），或任意接受 JSON POST 的地址 |
| `PUBLIC_URL` | 通知里登录链接的域名（Railway 上自动识别） |
| `QQ_WATCHDOG_INTERVAL` | 登录检查间隔秒数，默认 30；`QQ_WATCHDOG=off` 关闭 |
| `QQ_TOOLSETS` | 只开放这些类别，如 `chat,events,message,qzone,qzone_web` |
| `QQ_READ_ONLY` | `1` = 只开放只读工具 |
| `QQ_DISABLED_TOOLS` | 逗号分隔的要隐藏的工具名 |
| `ONEBOT_WS_URL` / `ONEBOT_ACCESS_TOKEN` | 改连其他 OneBot v11 实现（NapCat、LLBot…），不用自带的 |

## 开发

```bash
npm install
npm test        # 离线端到端测试（假 OneBot 服务 + 真实 MCP HTTP）
node dist/index.js            # stdio 模式
MCP_AUTH_TOKEN=... node dist/index.js serve   # HTTP 模式
```

## 许可

本项目代码采用 MIT 许可。它依赖的 [SnowLuma](https://github.com/TomyJan/SnowLuma)（运行时，以及提供动作目录的 npm 包 `@snowluma/mcp`）采用**源码可见、非商业**许可，构建时从官方渠道下载，不包含在本仓库中；商业使用请先取得 SnowLuma 作者授权。QQ 是腾讯的软件。本项目与腾讯、SnowLuma 均无关联。
