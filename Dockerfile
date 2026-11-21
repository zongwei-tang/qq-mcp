# qq-mcp all-in-one: Linux QQ (real client on a virtual display) + SnowLuma (OneBot v11 runtime) + this MCP server.
# One container, one public port ($PORT, Streamable HTTP at /mcp), one volume at /data (QQ login + history survive restarts).

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc && mkdir -p dist/catalog && cp src/catalog/actions.json dist/catalog/ && npm prune --omit=dev

FROM node:24-bookworm-slim
ARG TARGETARCH
# Linux QQ build (official CDN, from https://im.qq.com/linuxqq/)
ARG QQ_BASE_URL=https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.35/release/1763096b
ARG QQ_FILE_PREFIX=QQ_3.2.33_260902
ARG SNOWLUMA_VERSION=v2.4.2

ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Shanghai DISPLAY=:1 \
    DATA_DIR=/data SNOWLUMA_HOME=/app/snowluma SNOWLUMA_WEBUI_PORT=5099 SNOWLUMA_LOG_LEVEL=info \
    SNOWLUMA_HOOK_AUTOLOAD=1 SNOWLUMA_SCREEN=1280x800x24 \
    HOST=0.0.0.0 PORT=8000 QQ_DISPLAY=:1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl dbus-user-session ffmpeg fluxbox fonts-wqy-zenhei fonts-noto-color-emoji \
      libasound2 libatspi2.0-0 libgbm1 libgtk-3-0 libnotify4 libnss3 libsecret-1-0 \
      procps supervisor tzdata xdotool xdg-utils xvfb && \
    arch="$(dpkg --print-architecture)" && \
    curl -fL --retry 3 -o /tmp/qq.deb "${QQ_BASE_URL}/${QQ_FILE_PREFIX}_${arch}_01.deb" && \
    (dpkg -i /tmp/qq.deb || apt-get -f install -y --no-install-recommends) && rm -f /tmp/qq.deb && \
    case "$arch" in amd64) sl=linux-x64 ;; arm64) sl=linux-arm64 ;; esac && \
    mkdir -p /app/snowluma && \
    curl -fL --retry 3 "https://github.com/SnowLuma/SnowLuma/releases/download/${SNOWLUMA_VERSION}/SnowLuma-${SNOWLUMA_VERSION}-${sl}-lite.tar.gz" | tar -xz -C /app/snowluma && \
    test -f /app/snowluma/index.mjs && \
    echo "$TZ" > /etc/timezone && ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime && \
    groupadd --gid 1001 qq && useradd --no-log-init --uid 1001 --gid 1001 --home-dir /app --shell /bin/bash qq && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

COPY --from=build /src/dist /app/qq-mcp/dist
COPY --from=build /src/node_modules /app/qq-mcp/node_modules
COPY package.json /app/qq-mcp/
COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh && chown -R qq:qq /app /opt/QQ

VOLUME ["/data"]
EXPOSE 8000
CMD ["/start.sh"]
