# qq-mcp

MCP server that drives **your own QQ account** — 260+ tools: read/send messages (text, images, voice, video, files, @, replies, 合并转发), friends, groups (management, notices, files, albums, essence, todo…), **QQ 空间** (说说 publish/delete/like/comment/forward, friends' feed, visitors, 留言板, albums & photos, like lists…), live events, and a raw `onebot_call` / `qzone_request` escape hatch.

How it works: a real Linux QQ client runs on a virtual display inside the container; [SnowLuma](https://github.com/SnowLuma/SnowLuma) exposes it as OneBot v11; this server turns every action into an MCP tool and adds convenience tools on top.

## Run (Docker, one container)

```bash
docker build -t qq-mcp .
docker run -d --name qq-mcp -e MCP_AUTH_TOKEN=$(openssl rand -hex 24) -v qq-data:/data -p 8000:8000 --shm-size=1g qq-mcp
```

MCP endpoint (Streamable HTTP): `http://host:8000/mcp/<MCP_AUTH_TOKEN>` (or `/mcp` with `Authorization: Bearer <token>`).

Log in: call `qq_login` — it returns a screenshot of the QQ login window with a QR code; scan it with the QQ phone app. The session is kept in `/data`.

## Railway

Deploy this repo (Dockerfile build), add a volume at `/data`, set `MCP_AUTH_TOKEN` (≥ 24 random chars), generate a domain. `railway.json` sets the health check.

## Options (env)

| Var | Meaning |
| --- | --- |
| `MCP_AUTH_TOKEN` | required for `serve` |
| `QQ_TOOLSETS` | only these categories, e.g. `chat,events,message,qzone,qzone_web` |
| `QQ_READ_ONLY` | `1` = only read-only tools |
| `QQ_DISABLED_TOOLS` | comma-separated tool names to hide |
| `ONEBOT_WS_URL` / `ONEBOT_ACCESS_TOKEN` | use another OneBot v11 runtime (NapCat, LLBot…) instead of the bundled one |

`node dist/index.js tools` lists every tool. `npm test` runs the offline end-to-end suite.

Using an automated client on a personal QQ account is against Tencent's terms and can get the account restricted. Use at your own risk.
