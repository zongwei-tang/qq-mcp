import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';
const env = process.env;

const list = (v?: string) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const settings = {
  /** OneBot v11 WebSocket of the QQ runtime (SnowLuma / NapCat / LLBot all work). */
  onebotWs: env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001/',
  onebotToken: env.ONEBOT_ACCESS_TOKEN || '',
  /** Per-call timeout for OneBot actions (ms). */
  actionTimeout: Number(env.QQ_ACTION_TIMEOUT_MS || 60_000),
  /** X display the QQ client draws on (for login screenshots / clicks). */
  display: env.QQ_DISPLAY || env.DISPLAY || ':1',
  /** Optional command that restarts the QQ client. Default: stop the QQ main process; the launcher starts it again. */
  restartCmd: env.QQ_RESTART_CMD || '',
  home: env.QQ_MCP_HOME || path.join(os.homedir(), '.qq-mcp'),
  downloadDir: env.QQ_DOWNLOAD_DIR || path.join(env.QQ_MCP_HOME || path.join(os.homedir(), '.qq-mcp'), 'downloads'),
  /** Only expose read-only tools. */
  readOnly: /^(1|true|yes)$/i.test(env.QQ_READ_ONLY || ''),
  /** Comma-separated categories to expose (default: all). */
  toolsets: new Set(list(env.QQ_TOOLSETS).map((s) => s.toLowerCase())),
  disabledTools: new Set(list(env.QQ_DISABLED_TOOLS)),
  maxOutputChars: Number(env.QQ_MAX_OUTPUT_CHARS || 60_000),
  eventBuffer: Number(env.QQ_EVENT_BUFFER || 5000),
};
