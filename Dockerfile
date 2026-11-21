# qq-mcp all-in-one: Linux QQ (real client on a virtual display) + SnowLuma (OneBot v11 runtime) + this MCP server.
# One container, one public port ($PORT, Streamable HTTP at /mcp), one volume at /data (QQ login + history survive restarts).

# image that provides /opt/QQ (see the qq stage below)
ARG QQ_IMAGE=linyuchen/pmhq:9.0.6

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc && npm prune --omit=dev

# Where the Linux QQ client comes from:
#  - default: the unmodified /opt/QQ (QQ 3.2.34) inside this public image, because Tencent's CDN refuses most non-China IPs
#  - or build with --build-arg QQ_DEB_URL=<official .deb from https://im.qq.com/linuxqq/> to install Tencent's package instead
FROM ${QQ_IMAGE} AS qq

FROM node:24-bookworm-slim
ARG SNOWLUMA_VERSION=v2.4.2
ARG SNOWLUMA_REPO=TomyJan/SnowLuma
ARG QQ_DEB_URL=

ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Shanghai DISPLAY=:1 \
    DATA_DIR=/data SNOWLUMA_HOME=/app/snowluma SNOWLUMA_WEBUI_PORT=5099 SNOWLUMA_LOG_LEVEL=info \
    SNOWLUMA_HOOK_AUTOLOAD=1 SNOWLUMA_SCREEN=1280x800x24 \
    HOST=0.0.0.0 PORT=8000 QQ_DISPLAY=:1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl dbus-user-session ffmpeg fluxbox fonts-wqy-zenhei fonts-noto-color-emoji \
      libasound2 libatspi2.0-0 libgbm1 libgtk-3-0 libnotify4 libnss3 libsecret-1-0 libxss1 libxtst6 libcups2 libxkbfile1 libdrm2 \
      procps supervisor tzdata xdotool xdg-utils xvfb && \
    arch="$(dpkg --print-architecture)" && \
    case "$arch" in amd64) sl=linux-x64 ;; arm64) sl=linux-arm64 ;; esac && \
    mkdir -p /app/snowluma && \
    curl -fL --retry 3 "https://github.com/${SNOWLUMA_REPO}/releases/download/${SNOWLUMA_VERSION}/SnowLuma-${SNOWLUMA_VERSION}-${sl}-lite.tar.gz" | tar -xz -C /app/snowluma && \
    test -f /app/snowluma/index.mjs && \
    echo "$TZ" > /etc/timezone && ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime && \
    groupadd --gid 1001 qq && useradd --no-log-init --uid 1001 --gid 1001 --home-dir /app --shell /bin/bash qq && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

COPY --from=qq /opt/QQ /opt/QQ
RUN if [ -n "$QQ_DEB_URL" ]; then \
      curl -fL --retry 3 -o /tmp/qq.deb "$QQ_DEB_URL" && rm -rf /opt/QQ && dpkg-deb -x /tmp/qq.deb / && rm -f /tmp/qq.deb && test -x /opt/QQ/qq; \
    fi
COPY --from=build /src/dist /app/qq-mcp/dist
COPY --from=build /src/node_modules /app/qq-mcp/node_modules
COPY package.json /app/qq-mcp/
COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/start.sh /start.sh
COPY docker/qq-launcher.mjs /app/qq-launcher.mjs
RUN chmod +x /start.sh && chown -R qq:qq /app /opt/QQ

EXPOSE 8000
CMD ["/start.sh"]
