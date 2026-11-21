# qq-mcp

[简体中文](README.md) | **English**

An MCP server that lets an AI act as **your own QQ account**: read and send messages, manage groups, and use QQ空间 (Qzone). 260 tools, one Docker container, deployable to the cloud (Streamable HTTP), and it logs itself back in when it drops.

> ⚠️ Automating a personal QQ account is against Tencent's terms and can get the account restricted. Use at your own risk, on your own account only.

## What it can do

| Area | Example tools |
| --- | --- |
| Chat | `find_contact` (find people/groups by name) · `read_chat` · `search_chat` · `send_text` (@mentions, quote replies, emoji) · `send_image` / `send_voice` / `send_video` / `send_file` · `reply_to_message` · `forward_messages` (合并转发 bundles) · `poke` · `view_image` (lets the AI see pictures) |
| Live | `get_unread` · `list_recent_chats` · `wait_for_message` · `get_events` (recalls, joins, friend requests…) |
| Groups | member lists, mute, kick, admins, group cards, titles, announcements, group files, group albums, essence messages, group to-dos, join requests… |
| QQ空间 (Qzone) | post 说说 (with images and visibility), delete, like, comment/reply, forward, friends' feed, visitors, 留言板 message board (read/write/reply/delete), albums and photos, who liked a post, view/like counts, intimacy ranking |
| Escape hatches | `onebot_call` calls any OneBot action · `qzone_request` calls any Qzone web endpoint with your logged-in session |

`node dist/index.js tools` lists every tool; `QQ_TOOLSETS` / `QQ_READ_ONLY` expose only part of them.

## How it works

The container runs the **official, unmodified Linux QQ client** on a virtual display. [SnowLuma](https://github.com/TomyJan/SnowLuma) turns it into a OneBot v11 API, and this project turns every action into an MCP tool, then adds chat convenience tools, Qzone extras, QR login and a login watchdog.

What existing projects did not solve:

- **No extra privileges needed.** SnowLuma injects into QQ with ptrace, and most cloud platforms (`ptrace_scope=1`) only allow tracing your own child processes. Here SnowLuma's runtime process launches QQ itself (`docker/qq-launcher.mjs`), so injection also works on platforms like Railway.
- **QR login over MCP or a web page.** `qq_login` returns a screenshot of the login window; `/login/<token>` is a page with a live, auto-refreshing QR code.
- **Login watchdog.** Every 30 seconds it checks the login: clicks 登录 for the remembered account, closes "logged out" pop-ups, and restarts QQ if it looks logged in but the API died. Only when a QR scan is truly required does it notify you via `NOTIFY_WEBHOOK`.

## Deploy

### Docker

```bash
docker build -t qq-mcp .
docker run -d --name qq-mcp --shm-size=1g \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 24) \
  -v qq-data:/data -p 8000:8000 qq-mcp
```

MCP endpoint (Streamable HTTP): `http://<host>:8000/mcp/<MCP_AUTH_TOKEN>`, or `/mcp` with `Authorization: Bearer <token>`.
Open `http://<host>:8000/login/<MCP_AUTH_TOKEN>` and scan the QR code with the QQ phone app. The session is kept in `/data` and restored automatically after restarts.

### Railway

Deploy from your own copy of this repository (Dockerfile build), attach a volume at `/data`, set `MCP_AUTH_TOKEN` (24+ random characters) and generate a domain. `railway.json` configures the health check.

- A QQ client uses about 1 GB of RAM.
- Deploy from a **private** fork. Railway's GitHub integration writes deployment records and commit statuses (project/service IDs, dashboard links) back to the connected repository.

### Where the QQ client comes from

Tencent's download servers refuse most non-China IPs, so by default the Dockerfile copies the unmodified `/opt/QQ` (QQ 3.2.34) out of the public image `linyuchen/pmhq`. If you build in mainland China you can use the official package instead:

```bash
docker build --build-arg QQ_DEB_URL=<.deb link from https://im.qq.com/linuxqq/> -t qq-mcp .
```

## Configuration (environment variables)

| Variable | Meaning |
| --- | --- |
| `MCP_AUTH_TOKEN` | Required. Access token for the MCP endpoint and login page |
| `NOTIFY_WEBHOOK` | Where to send "needs a QR scan" alerts: a Discord webhook, any URL containing `{text}` (Bark, Server酱…), or any URL that accepts a JSON POST |
| `PUBLIC_URL` | Base URL used for the login link in alerts (detected automatically on Railway) |
| `QQ_WATCHDOG_INTERVAL` | Seconds between login checks, default 30; `QQ_WATCHDOG=off` disables the watchdog |
| `QQ_TOOLSETS` | Only expose these categories, e.g. `chat,events,message,qzone,qzone_web` |
| `QQ_READ_ONLY` | `1` = only read-only tools |
| `QQ_DISABLED_TOOLS` | Comma-separated tool names to hide |
| `ONEBOT_WS_URL` / `ONEBOT_ACCESS_TOKEN` | Connect to another OneBot v11 implementation (NapCat, LLBot…) instead of the bundled one |

## Development

```bash
npm install
npm test        # offline end-to-end tests (fake OneBot server + real MCP over HTTP)
node dist/index.js            # stdio mode
MCP_AUTH_TOKEN=... node dist/index.js serve   # HTTP mode
```

## License

This project's code is MIT licensed. It depends on [SnowLuma](https://github.com/TomyJan/SnowLuma) (the runtime, and the npm package `@snowluma/mcp` that provides the action catalog), which uses a **source-available, non-commercial** license. Both are downloaded from their official sources at build time and are not included in this repository. Ask the SnowLuma authors before any commercial use. QQ is Tencent's software. This project is not affiliated with Tencent or SnowLuma.
