/**
 * dsh-wechat-clawbot — Host half.
 *
 * Owns one Python iLink (WeChat ClawBot) transport child process, the
 * per-peer DSH sessions it feeds through `ctx.agents`, and the
 * `/api/wechat-clawbot/*` routes the browser settings page calls.
 *
 * No `@deepseek-ai/*` import on purpose: the bundle is installed from a local
 * directory, so only Node built-ins and the repository's own `vendor/qrcode.mjs`
 * are guaranteed to resolve. Every Harness capability arrives through `ctx`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import qrcode from './vendor/qrcode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = 'dsh-wechat-clawbot';
const PLUGIN_VERSION = '0.12.4';
const PLUGIN_LICENSE = 'MIT';
const API_PREFIX = '/api/wechat-clawbot';
const BRIDGE_SCRIPT = join(HERE, 'bridge', 'host_bridge.py');

const RESTART_DELAYS_MS = [1000, 2000, 5000, 15000, 30000];
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
/** How long a numbered choice list stays answerable. */
const CHOICE_TTL_MS = 5 * 60 * 1000;
/** How long a WeChat plan review / question waits for an answer. */
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
/** Model lists larger than this ask the user to type the id instead. */
const MAX_MODEL_CHOICES = 30;
/** How many sessions /会话 lists at once. */
const MAX_SESSION_CHOICES = 30;
/** GUI workspace created for the channel's own chat directory, when unregistered. */
const GROUP_WORKSPACE_TITLE = '微信 clawbot';
/** Chinese sub-commands for /会话. */
const CHAT_SUBCOMMANDS = {
  新增: 'new',
  新建: 'new',
  新: 'new',
  new: 'new',
  列表: 'list',
  list: 'list',
};

/**
 * Command names, Chinese first. English spellings stay as aliases so existing
 * habits and older docs keep working.
 */
const COMMAND_ALIASES = {
  '/帮助': 'help',
  '/help': 'help',
  '/状态': 'status',
  '/status': 'status',
  '/重置': 'reset',
  '/reset': 'reset',
  '/new': 'reset',
  '/模型': 'model',
  '/model': 'model',
  '/models': 'model',
  '/思考': 'think',
  '/think': 'think',
  '/reasoning': 'think',
  '/计划': 'plan',
  '/plan': 'plan',
  '/对话': 'chat',
  '/会话': 'chat',
  '/chat': 'chat',
  '/sessions': 'chat',
  '/conversation': 'chat',
  '/cwd': 'workspace',
  '/pwd': 'workspace',
  '/工作区': 'workspace',
  '/ws': 'workspace',
  '/workspace': 'workspace',
  '/权限': 'permission',
  '/perm': 'permission',
  '/permission': 'permission',
};

/**
 * Chinese receipts for the plan-mode command's own result texts. The wording
 * belongs to the plan-mode plugin, so unknown strings fall through verbatim.
 */
const PLAN_RESULT_LABELS = {
  'Plan mode on. Use /plan off to leave.': '已生效',
  'Entering plan mode (applies from the next step). Use /plan off to leave.': '已排队，下一步生效',
  'Plan mode off.': '已生效',
  'Leaving plan mode (applies from the next step).': '已排队，下一步生效',
  'Plan mode entry cancelled.': '已取消本次开启',
  'Plan mode is already inactive.': '本来就是关闭',
  'Plan mode is already active.': '本来就是开启',
};

/** Chinese sub-commands for the workspace command. */
const WORKSPACE_SUBCOMMANDS = {
  新增: 'add',
  添加: 'add',
  new: 'add',
  add: 'add',
  使用: 'use',
  切换: 'use',
  use: 'use',
  switch: 'use',
};

/** Chinese permission names mapped to the preset ids. */
const PERMISSION_ALIASES = {
  只读: 'read-only',
  写入: 'workspace-write',
  工作区写入: 'workspace-write',
  完全: 'danger-full-access',
  完全权限: 'danger-full-access',
};

const PERMISSION_LABELS = {
  'read-only': '只读',
  'workspace-write': '写入',
  'danger-full-access': '完全',
};

const DEFAULT_CONFIG = {
  enabled: true,
  autoStart: true,
  replyEnabled: true,
  replyDisabledText: '微信桥接已连接，但「接入本地插件/提示词」已关闭，暂不自动回复。发送 /状态 可查看连接状态。',
  useLocalPrompt: true,
  systemPrompt:
    '你是部署在微信里的 DeepSeek Harness 助手。回复使用简体中文，简洁直接；代码、列表等用适合微信阅读的纯文本格式。',
  cwd: '',
  provider: '',
  model: '',
  reasoningEffort: '',
  workspaces: [],
  permission: 'workspace-write',
  allowFrom: [],
  progressMessages: true,
  announceSession: true,
  messageMaxChars: 2000,
  pythonPath: '',
  logLevel: 'INFO',
  replyTimeoutS: 1800,
  longPollTimeoutS: 35,
};

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function stateRoot() {
  return join(dshHome(), 'wechat-clawbot');
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeId(raw) {
  const cleaned = String(raw || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || 'unknown';
}

/**
 * Format a session creation time for a choice label.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} `MM-DD HH:mm`, or an empty string for an invalid value.
 */
function formatStamp(ms) {
  const date = new Date(Number(ms) || 0);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function splitText(text, limit) {
  const body = String(text || '').trim();
  if (!body) return [];
  if (body.length <= limit) return [body];
  const chunks = [];
  let rest = body;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    const head = rest.slice(0, cut).trim();
    if (head) chunks.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function publicConfig(config) {
  return {
    enabled: config.enabled,
    autoStart: config.autoStart,
    replyEnabled: config.replyEnabled,
    replyDisabledText: config.replyDisabledText,
    useLocalPrompt: config.useLocalPrompt,
    systemPrompt: config.systemPrompt,
    cwd: config.cwd,
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    workspaces: config.workspaces,
    permission: config.permission,
    allowFrom: config.allowFrom,
    progressMessages: config.progressMessages,
    announceSession: config.announceSession,
    messageMaxChars: config.messageMaxChars,
    pythonPath: config.pythonPath,
    logLevel: config.logLevel,
    replyTimeoutS: config.replyTimeoutS,
    longPollTimeoutS: config.longPollTimeoutS,
  };
}

function normalizeConfig(raw) {
  const next = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  next.enabled = Boolean(next.enabled);
  next.autoStart = Boolean(next.autoStart);
  next.replyEnabled = Boolean(next.replyEnabled);
  next.useLocalPrompt = Boolean(next.useLocalPrompt);
  next.progressMessages = Boolean(next.progressMessages);
  next.announceSession = next.announceSession === undefined ? true : Boolean(next.announceSession);
  next.allowFrom = Array.isArray(next.allowFrom)
    ? next.allowFrom.map((x) => String(x).trim()).filter(Boolean)
    : [];
  next.workspaces = Array.isArray(next.workspaces)
    ? Array.from(new Set(next.workspaces.map((x) => String(x).trim()).filter(Boolean)))
    : [];
  next.messageMaxChars = Number.isFinite(Number(next.messageMaxChars))
    ? Math.min(Math.max(Number(next.messageMaxChars), 200), 8000)
    : DEFAULT_CONFIG.messageMaxChars;
  next.replyTimeoutS = Number.isFinite(Number(next.replyTimeoutS))
    ? Math.min(Math.max(Number(next.replyTimeoutS), 30), 86400)
    : DEFAULT_CONFIG.replyTimeoutS;
  next.longPollTimeoutS = Number.isFinite(Number(next.longPollTimeoutS))
    ? Math.min(Math.max(Number(next.longPollTimeoutS), 5), 120)
    : DEFAULT_CONFIG.longPollTimeoutS;
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(next.permission)) {
    next.permission = DEFAULT_CONFIG.permission;
  }
  const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];
  next.logLevel = levels.includes(String(next.logLevel).toUpperCase())
    ? String(next.logLevel).toUpperCase()
    : 'INFO';
  for (const key of ['replyDisabledText', 'systemPrompt', 'cwd', 'provider', 'model', 'reasoningEffort', 'pythonPath']) {
    next[key] = String(next[key] ?? '');
  }
  return next;
}

function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  });
}

/**
 * Mask one secret-looking value, keeping only enough to recognise it.
 * @param {string} value - the raw value.
 * @returns {string} the masked value.
 */
function maskValue(value) {
  const text = String(value);
  if (text.length <= 4) return '…';
  return `${text.slice(0, 4)}…`;
}

/**
 * Strip credentials out of text before it reaches a log file, the settings page,
 * or an error message. The plugin never needs a token in its own output, so a
 * deny-by-pattern redactor is enough and keeps diagnostics readable.
 * @param {unknown} input - text or error to clean.
 * @returns {string} the cleaned text.
 */
export function redact(input) {
  let text;
  if (input instanceof Error) text = input.message;
  else if (typeof input === 'string') text = input;
  else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  if (!text) return '';
  return (
    text
      // JSON / query / CLI style: bot_token":"abc", token=abc, verify_code: "123456"
      .replace(
        /\b(bot_token|context_token|typing_ticket|verify_code|token)(\s*["']?\s*[:=]\s*["']?)([A-Za-z0-9._:@+/=-]{6,})/gi,
        (_match, key, separator, value) => `${key}${separator}${maskValue(value)}`,
      )
      // HTTP header style
      .replace(/\b(Bearer\s+)([A-Za-z0-9._:@+/=-]{6,})/gi, (_match, prefix, value) => `${prefix}${maskValue(value)}`)
      // iLink ids carry an account id before @; mask its body but keep the suffix.
      .replace(/\b([0-9a-f]{8,})(@im\.(?:bot|wechat))/gi, (_match, id, suffix) => `${id.slice(0, 4)}…${suffix}`)
      // Windows profile directories leak the OS user name into shared logs.
      .replace(/[A-Za-z]:\\Users\\[^\\\s"'<>|]+/g, (match) => `${match.slice(0, 3)}\\Users\\<user>`)
  );
}

/**
 * Render an account id for display: keep the domain suffix, mask the body.
 * @param {string} accountId - the raw account id, empty when signed out.
 * @returns {string} the display form.
 */
function maskAccount(accountId) {
  const text = String(accountId || '');
  if (!text) return '';
  const at = text.indexOf('@');
  if (at <= 4) return redact(text);
  return `${text.slice(0, 4)}…${text.slice(at)}`;
}

/**
 * Mask a session id for display; the channel embeds the peer id in it.
 * @param {string} sessionId - the raw session id.
 * @returns {string} the display form.
 */
function maskSessionId(sessionId) {
  const text = String(sessionId || '');
  if (!text) return '-';
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}…${text.slice(-6)}`;
}

/**
 * Compare two filesystem paths the way Windows would for grouping purposes.
 * @param {string} path - the path to normalize.
 * @returns {string} a comparable form.
 */
function normalizePath(path) {
  return String(path || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function textResponse(text, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(text, {
    status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  });
}

export class WechatClawbot {
  constructor(ctx) {
    this.ctx = ctx;
    this.dir = stateRoot();
    this.configPath = join(this.dir, 'config.json');
    this.logDir = join(this.dir, 'log');
    this.bridgeStateDir = join(this.dir, 'state');
    this.logFile = join(this.logDir, 'plugin.log');
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(this.bridgeStateDir, { recursive: true });

    this.config = this.loadConfig();
    this.status = this.loadStatus();
    this.lines = [];
    this.child = null;
    this.childBuffer = '';
    this.stopping = false;
    this.restartAttempt = 0;
    this.restartTimer = null;
    this.disposed = false;

    this.handles = new Map(); // peerId -> { sessionId, handle }
    this.activeSessions = new Map(); // peerId -> sessionId
    this.activeCwd = null; // runtime-only workspace chosen from WeChat
    this.tails = new Map(); // peerId -> Promise
    this.waiters = new Map(); // sessionId -> waiter
    this.typing = new Map(); // peerId -> boolean
    this.pendingChoices = new Map(); // peerId -> { kind, items, createdAt }
    this.pendingQuestions = new Map(); // peerId -> { question, options, resolve, timer }
    this.contextTokens = new Map(); // peerId -> latest context token
    this.greeted = new Set(); // sessionIds whose parameters were already announced
  }

  // ------------------------------------------------------------ persistence

  loadConfig() {
    if (!existsSync(this.configPath)) {
      const defaults = normalizeConfig({});
      this.writeConfig(defaults);
      return defaults;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf8').replace(/^\uFEFF/, ''));
      const normalized = normalizeConfig(parsed);
      // A config written by an older version misses newly added keys; write the
      // merged form back so the file and the page agree.
      if (Object.keys(parsed).length !== Object.keys(normalized).length) {
        this.writeConfig(normalized);
      }
      return normalized;
    } catch (error) {
      this.log('warn', `config.json 解析失败，使用默认值：${String(error)}`);
      return normalizeConfig({});
    }
  }

  writeConfig(config) {
    try {
      writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.log('error', `写入 config.json 失败：${String(error)}`);
    }
  }

  saveConfig(patch) {
    this.config = normalizeConfig({ ...this.config, ...(patch || {}) });
    this.writeConfig(this.config);
    this.log(
      'info',
      `保存配置 enabled=${this.config.enabled} autoStart=${this.config.autoStart} replyEnabled=${this.config.replyEnabled} useLocalPrompt=${this.config.useLocalPrompt}`,
    );
    return this.config;
  }

  loadStatus() {
    const file = join(this.dir, 'status.json');
    const base = {
      phase: 'idle',
      message: '未启动',
      qrcodeUrl: '',
      accountId: '',
      lastError: '',
      updatedAt: nowIso(),
    };
    if (!existsSync(file)) return base;
    try {
      return { ...base, ...JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      return base;
    }
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch, updatedAt: nowIso() };
    try {
      const onDisk = { ...this.status, accountId: maskAccount(this.status.accountId) };
      writeFileSync(join(this.dir, 'status.json'), `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
    } catch {
      /* status persistence is best effort */
    }
  }

  // ----------------------------------------------------------------- logging

  rotateLogIfNeeded() {
    try {
      const info = statSync(this.logFile);
      if (info.size < LOG_ROTATE_BYTES) return;
      renameSync(this.logFile, `${this.logFile}.1`);
    } catch {
      /* no log yet, or the file vanished — nothing to rotate */
    }
  }

  log(level, text) {
    const line = `${nowIso()} ${level.toUpperCase()} ${redact(String(text ?? ''))}`;
    this.lines.push(line);
    if (this.lines.length > 600) this.lines.splice(0, this.lines.length - 600);
    this.logWrites = (this.logWrites || 0) + 1;
    if (this.logWrites % 200 === 0) this.rotateLogIfNeeded();
    try {
      appendFileSync(this.logFile, `${line}\n`, 'utf8');
    } catch {
      /* ignore */
    }
    if (level === 'error') console.error(`[wechat-clawbot] ${line}`);
  }

  readBridgeLogTail(maxLines = 200) {
    const file = join(this.bridgeStateDir, 'log', 'bridge.log');
    if (!existsSync(file)) return [];
    try {
      const text = readFileSync(file, 'utf8');
      const all = text.split(/\r?\n/).filter(Boolean);
      return all.slice(-maxLines).map((line) => redact(line));
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ bridge

  bridgeSend(payload) {
    if (!this.child || !this.child.stdin || this.child.killed) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch (error) {
      this.log('warn', `向桥接进程写入失败：${String(error)}`);
      return false;
    }
  }

  pythonCommand() {
    const configured = (this.config.pythonPath || '').trim();
    const candidate = configured || (process.platform === 'win32' ? 'python' : 'python3');
    return { command: candidate, args: [] };
  }

  start() {
    if (this.disposed) return;
    if (!this.config.enabled) {
      this.setStatus({ phase: 'disabled', message: '插件已关闭（enabled=false）' });
      return;
    }
    if (this.child && !this.child.killed) return;
    if (!existsSync(BRIDGE_SCRIPT)) {
      this.setStatus({ phase: 'error', message: `找不到桥接脚本：${BRIDGE_SCRIPT}`, lastError: 'missing bridge script' });
      this.log('error', `找不到桥接脚本：${BRIDGE_SCRIPT}`);
      return;
    }

    const { command, args } = this.pythonCommand();
    const bridgeArgs = [
      ...args,
      BRIDGE_SCRIPT,
      '--state',
      this.bridgeStateDir,
      '--log-level',
      this.config.logLevel,
      '--allow-from',
      (this.config.allowFrom || []).join(','),
      '--long-poll-timeout',
      String(this.config.longPollTimeoutS),
    ];

    this.stopping = false;
    this.setStatus({ phase: 'starting', message: '正在启动微信桥接…' });
    this.log('info', `启动桥接：${command} ${bridgeArgs.map((x) => (x.includes(' ') ? `"${x}"` : x)).join(' ')}`);

    let child;
    try {
      child = spawn(command, bridgeArgs, {
        cwd: HERE,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.setStatus({ phase: 'error', message: `无法启动 Python：${String(error)}`, lastError: String(error) });
      this.log('error', `spawn 失败：${String(error)}`);
      return;
    }

    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const out = createInterface({ input: child.stdout });
    out.on('line', (line) => this.onBridgeLine(line));
    const err = createInterface({ input: child.stderr });
    err.on('line', (line) => {
      if (line.trim()) this.log('info', `[bridge] ${line.trim()}`);
    });

    child.on('error', (error) => {
      this.child = null;
      this.setStatus({
        phase: 'error',
        message: `Python 启动失败：${String(error)}（可在设置里填写 pythonPath）`,
        lastError: String(error),
      });
      this.log('error', `子进程错误：${String(error)}`);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping || this.disposed) {
        this.setStatus({ phase: 'idle', message: '桥接已停止' });
        return;
      }
      this.setStatus({
        phase: 'error',
        message: `桥接进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`,
        lastError: `exit ${code ?? signal}`,
      });
      this.log('error', `桥接进程退出 code=${code} signal=${signal}`);
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.disposed || !this.config.enabled || !this.config.autoStart) return;
    const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)];
    this.restartAttempt += 1;
    if (this.restartAttempt > RESTART_DELAYS_MS.length) {
      this.log('error', '桥接连续退出，已停止自动重启；请检查 Python 与网络后在插件页手动重启');
      return;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.bridgeSend({ type: 'shutdown' });
    const child = this.child;
    this.child = null;
    if (!child) {
      this.setStatus({ phase: 'idle', message: '桥接已停止' });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        setTimeout(finish, 400);
      }, 3000);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', finish);
    }).then(() => {
      this.setStatus({ phase: 'idle', message: '桥接已停止' });
    });
  }

  async restart(options = {}) {
    this.restartAttempt = 0;
    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 600));
    this.start();
    return this.status;
  }

  async logout() {
    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      rmSync(join(this.bridgeStateDir, 'ilink'), { recursive: true, force: true });
    } catch (error) {
      this.log('warn', `清除登录凭证失败：${String(error)}`);
    }
    this.setStatus({ phase: 'idle', message: '已退出登录，正在重新获取二维码…', accountId: '', qrcodeUrl: '' });
    this.restartAttempt = 0;
    this.start();
    return this.status;
  }

  onBridgeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.log('info', `[bridge] ${trimmed}`);
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'phase') {
      this.restartAttempt = 0;
      const patch = { phase: String(event.phase || 'unknown') };
      if (typeof event.message === 'string') patch.message = event.message;
      if (typeof event.qrcodeUrl === 'string') patch.qrcodeUrl = event.qrcodeUrl;
      if (typeof event.accountId === 'string' && event.accountId) patch.accountId = event.accountId;
      if (patch.phase === 'error') patch.lastError = patch.message || 'error';
      if (patch.phase === 'connected' || patch.phase === 'confirmed') {
        patch.lastError = '';
        patch.qrcodeUrl = '';
      }
      this.setStatus(patch);
      this.log('info', `phase=${patch.phase}${patch.message ? ` ${patch.message}` : ''}`);
      return;
    }
    if (event.type === 'log') {
      const level = String(event.level || 'info');
      this.log(level === 'warning' ? 'warn' : level, `[bridge] ${event.text ?? ''}`);
      return;
    }
    if (event.type === 'inbound') {
      this.handleInbound(event).catch((error) => {
        this.log('error', `处理微信消息失败：${String(error)}`);
      });
      return;
    }
  }

  // ------------------------------------------------------------- messaging

  sendText(peerId, text, contextToken) {
    const chunks = splitText(text, this.config.messageMaxChars);
    for (const chunk of chunks) {
      this.bridgeSend({ type: 'reply', peerId, contextToken, text: chunk });
    }
    if (chunks.length === 0) {
      this.bridgeSend({ type: 'reply', peerId, contextToken, text: '（空回复）' });
    }
  }

  async handleInbound(event) {
    const peerId = String(event.peerId || '');
    const text = String(event.text || '');
    const contextToken = String(event.contextToken || '');
    if (!peerId || !text.trim()) return;
    this.log('info', `收到消息 from=${peerId} len=${text.length}`);

    const trimmed = text.trim();
    this.contextTokens.set(peerId, contextToken);
    // A blocking plan review / question owns the next reply before anything else.
    if (this.pendingQuestions.has(peerId)) {
      if (this.answerPendingQuestion(peerId, trimmed, contextToken)) return;
    }
    // A pending numbered list owns bare digits; anything else clears it and
    // continues as a normal message or command.
    const choice = await this.takeChoice(peerId, trimmed);
    if (choice?.text) this.sendText(peerId, choice.text, contextToken);
    if (choice?.handled) return;
    if (!trimmed.startsWith('/')) this.clearChoices(peerId);

    const command = await this.routeCommand(peerId, trimmed);
    if (command) {
      this.sendText(peerId, command, contextToken);
      return;
    }

    if (!this.config.replyEnabled) {
      this.log('info', 'replyEnabled=false，跳过本地 agent');
      this.sendText(peerId, this.config.replyDisabledText || DEFAULT_CONFIG.replyDisabledText, contextToken);
      return;
    }

    await this.runExclusive(peerId, async () => {
      this.bridgeSend({ type: 'typing', peerId, on: true });
      if (this.config.progressMessages) {
        this.sendText(peerId, '⏳ 正在处理，请稍候…', contextToken);
      }
      try {
        const { sessionId, handle } = await this.sessionFor(peerId);
        if (this.config.announceSession && !this.greeted.has(sessionId)) {
          this.greeted.add(sessionId);
          this.log('info', `播报会话参数（${sessionId}）`);
          this.sendText(peerId, this.sessionCardText(), contextToken);
        }
        const waiter = this.expectTurn(sessionId);
        try {
          await handle.agent.followup(userMessage(text));
        } catch (error) {
          this.finishWaiter(sessionId, { text: '', reason: 'error', error: String(error) });
          throw error;
        }
        const outcome = await waiter;
        const reply = (outcome.text || '').trim();
        if (!reply) {
          if (outcome.reason === 'blocked') {
            const healed = await this.ensureUnarchived(sessionId);
            this.log('warn', `会话 ${sessionId} 本轮被 pre-step 拦截（blocked）`);
            this.sendText(
              peerId,
              healed
                ? '⚠️ 本轮被会话状态拦截，已解除归档，请再发一次。'
                : '⚠️ 本轮被拦截（blocked），会话可能处于归档/受限状态；请再发一次，或发 /重置 开新会话。',
              contextToken,
            );
          } else {
            const reason = outcome.reason ? `（${outcome.reason}）` : '';
            this.sendText(peerId, `⚠️ 本轮没有生成回复${reason}`, contextToken);
          }
        } else {
          this.sendText(peerId, reply, contextToken);
        }
      } catch (error) {
        this.log('error', `agent 处理失败：${String(error)}`);
        this.sendText(peerId, `⚠️ 本地 agent 不可用：${String(error?.message || error)}`, contextToken);
      } finally {
        this.bridgeSend({ type: 'typing', peerId, on: false });
      }
    });
  }

  selectionOf() {
    let fallback = {};
    try {
      fallback = this.ctx.get('agentDefaultModel')?.currentSelection?.() || {};
    } catch {
      fallback = {};
    }
    return {
      provider: this.config.provider || fallback.provider || '',
      model: this.config.model || fallback.model || '',
    };
  }

  currentCwd() {
    if (this.activeCwd && isAbsolute(this.activeCwd)) return this.activeCwd;
    return this.config.cwd && isAbsolute(this.config.cwd) ? this.config.cwd : join(this.dir, 'workspace');
  }

  /** Open a fresh session for this peer and make it active. */
  newSession(peerId) {
    const base = `wechat-${sanitizeId(peerId)}`;
    const sessionId = `${base}__${Date.now().toString(36)}`;
    this.activeSessions.set(peerId, sessionId);
    const entry = this.handles.get(peerId);
    if (entry) {
      this.handles.delete(peerId);
      if (entry.owned) entry.handle.dispose().catch(() => {});
    }
    this.log('info', `开启新会话 ${sessionId}`);
    return sessionId;
  }

  /**
   * The parameter card shown on the first turn of a session and after any
   * command that changes what the next session runs with.
   * @returns {string} the multi-line card.
   */
  sessionCardText() {
    const { provider, model } = this.selectionOf();
    return [
      '🧭 会话参数',
      `工作区：${this.currentCwd()}`,
      `模型：${model || '（profile 默认）'}${provider ? `（${provider}）` : ''}`,
      `思考等级：${this.config.reasoningEffort || '默认'}`,
      `权限：${this.config.permission}`,
      `人设：${this.config.useLocalPrompt ? '本机提示词' : 'profile 默认'}`,
      `本地回复：${this.config.replyEnabled ? '开启' : '关闭'}`,
    ].join('\n');
  }

  /**
   * Append the parameter card to a command reply.
   * @param {string} text - the command result.
   * @param {string|null} sessionId - the session this reply just opened, which
   *   then counts as already announced; null keeps the reply card-only.
   * @returns {string} the reply, with the card when announcements are on.
   */
  withCard(text, sessionId) {
    if (!this.config.announceSession) return text;
    if (sessionId) this.greeted.add(sessionId);
    return `${text}\n\n${this.sessionCardText()}`;
  }

  ensureWorkspacePath(raw) {
    const cleaned = String(raw || '').trim().replace(/^["']+|["']+$/g, '');
    if (!cleaned) return { error: `⚠️ 需要绝对路径，例如：${this.currentCwd()}` };
    if (!isAbsolute(cleaned)) return { error: `⚠️ 请提供绝对路径，例如：${join(this.dir, 'workspace')}` };
    try {
      if (!existsSync(cleaned)) return { error: `⚠️ 目录不存在：${cleaned}\n如需创建：/工作区 新增 ${cleaned}` };
      if (!statSync(cleaned).isDirectory()) return { error: `⚠️ 不是目录：${cleaned}` };
    } catch (error) {
      return { error: `⚠️ 无法访问：${cleaned}（${String(error?.message || error)}）` };
    }
    return { path: cleaned };
  }

  async modelChoices() {
    const llm = this.ctx.get('llm');
    if (!llm || typeof llm.listProviders !== 'function') return [];
    let providers = [];
    try {
      providers = llm.listProviders() || [];
    } catch {
      return [];
    }
    const options = [];
    for (const provider of providers) {
      const id = provider.id || provider.provider || String(provider);
      try {
        const models = await llm.listModels(id);
        for (const model of models || []) {
          if (!model?.id) continue;
          options.push({ provider: id, model: model.id });
          if (options.length >= MAX_MODEL_CHOICES) return options;
        }
      } catch {
        /* a provider that cannot list models simply contributes none */
      }
    }
    return options;
  }

  async thinkEfforts() {
    const { provider, model } = this.selectionOf();
    const llm = this.ctx.get('llm');
    if (!provider || !model || typeof llm?.resolveModelInfo !== 'function') return [];
    try {
      const info = await llm.resolveModelInfo(provider, model);
      return (info?.reasoning?.efforts || []).map((entry) => ({
        id: String(entry.id),
        name: String(entry.name || entry.id),
      }));
    } catch {
      return [];
    }
  }

  workspaceChoices() {
    const current = this.currentCwd();
    const configured = Array.isArray(this.config.workspaces) ? this.config.workspaces : [];
    const paths = [...configured];

    // The channel's own list is not the only source: workspaces created in the
    // GUI live in the DSH workspace registry, and users expect to see them.
    const registry = this.ctx.get('workspaceRegistry');
    if (registry && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list() || []) {
          const path = String(workspace?.path || '').trim();
          if (path && !paths.includes(path)) paths.push(path);
        }
      } catch (error) {
        this.log('warn', `读取 DSH 工作区列表失败：${String(error)}`);
      }
    }

    // The active directory must always be visible, even before it is registered.
    if (current && !paths.includes(current)) paths.unshift(current);

    return paths.map((path) => ({ label: path, value: path, current: path === current }));
  }

  /**
   * Sessions in the current working directory, whoever created them — this
   * channel or the local GUI. Titles come from the query service when mounted;
   * otherwise a creation stamp labels the entry.
   * @param {string} peerId - the WeChat peer.
   * @returns {Promise<{label: string, value: string, current: boolean}[]>}
   */
  async sessionChoices(peerId) {
    const persistence = this.ctx.get('sessionPersistence');
    if (!persistence || typeof persistence.list !== 'function') return [];
    const cwd = this.currentCwd();
    const samePath = (left, right) =>
      String(left || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() ===
      String(right || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

    let snapshots = [];
    try {
      snapshots = (await persistence.list()) || [];
    } catch (error) {
      this.log('warn', `列出会话失败：${String(error)}`);
      return [];
    }

    const records = snapshots
      .filter((snap) => snap?.header && samePath(snap.header.cwd, cwd))
      .sort((a, b) => (Number(b.header.createdAt) || 0) - (Number(a.header.createdAt) || 0))
      .slice(0, MAX_SESSION_CHOICES);

    const active = this.sessionIdFor(peerId);
    const query = this.ctx.get('sessionQuery');
    const titles = new Map();
    if (query && typeof query.readTitleSnapshots === 'function') {
      try {
        const results = await query.readTitleSnapshots(records.map((snap) => snap.header.id));
        for (const result of results || []) {
          if (result?.status === 'fulfilled' && result.value?.title?.title) {
            titles.set(String(result.sessionId), String(result.value.title.title));
          }
        }
      } catch {
        /* titles are optional */
      }
    }

    return records.map((snap, index) => {
      const id = String(snap.header.id);
      const stamp = formatStamp(snap.header.createdAt);
      const title = titles.get(id);
      const short = title && title.length > 20 ? `${title.slice(0, 20)}…` : title;
      return {
        label: short ? `${short} · ${stamp}` : `会话 ${index + 1} · ${stamp}`,
        value: id,
        current: id === active,
      };
    });
  }

  async statusText(peerId) {
    const { provider, model } = this.selectionOf();
    const defaultCwd =
      this.config.cwd && isAbsolute(this.config.cwd) ? this.config.cwd : join(this.dir, 'workspace');
    const sessionId = this.sessionIdFor(peerId);
    let header;
    try {
      header = (await this.ctx.get('sessionPersistence')?.stat?.(sessionId))?.header;
    } catch {
      header = undefined;
    }
    const lines = [
      '📊 微信桥接状态',
      `连接：${this.status.phase}${this.status.message ? `（${this.status.message}）` : ''}`,
      `账号：${maskAccount(this.status.accountId) || '-'}`,
      `桥接进程：${this.child ? '运行中' : '未运行'}`,
      `本地回复：${this.config.replyEnabled ? '开启' : '关闭'}`,
      `本地提示词：${this.config.useLocalPrompt ? '开启' : '关闭'}`,
      `模型：${model || '（跟随 profile 默认）'}${provider ? `（${provider}）` : ''}`,
      `思考等级：${this.config.reasoningEffort || '默认'}`,
      `工作区（默认）：${defaultCwd}`,
      `工作区（会话）：${header?.cwd || '（尚未创建）'}`,
      `会话：${maskSessionId(sessionId)}`,
      `权限：${this.config.permission}`,
    ];
    if (header?.cwd && normalizePath(header.cwd) !== normalizePath(this.currentCwd())) {
      lines.push('提示：会话仍在旧工作区，发 /重置 可在当前工作区新建');
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------ question bridging

  /**
   * Attach a session to the workspace that owns the current directory, so the
   * GUI does not list it as "ungrouped" after the channel uses it.
   *
   * The channel's own chat directory is usually not a registered workspace, and
   * a session outside every workspace only shows up in the GUI while its agent
   * is live — it drops out of the sidebar as soon as the agent idles. Register
   * the directory on demand instead of leaving the session ungrouped.
   *
   * @param {string} sessionId - the session to group.
   */
  async ensureGrouped(sessionId) {
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry || typeof registry.resolveByPath !== 'function') return;
    const cwd = this.currentCwd();
    try {
      // `workspaceRegistry.create` owns an existing directory, so create it.
      mkdirSync(cwd, { recursive: true });
      let workspace = await registry.resolveByPath(cwd);
      if (!workspace && typeof registry.create === 'function') {
        workspace = await registry.create(cwd, GROUP_WORKSPACE_TITLE);
        this.log('info', `已为 ${cwd} 登记工作区「${GROUP_WORKSPACE_TITLE}」`);
      }
      if (!workspace || typeof workspace.attachSession !== 'function') return;
      const current = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
      if (current.includes(sessionId)) return;
      await workspace.attachSession(sessionId);
      this.log('info', `会话 ${sessionId} 已归入工作区 ${cwd}`);
    } catch (error) {
      this.log('warn', `归入工作区失败（${sessionId}）：${String(error)}`);
    }
  }

  /**
   * Find the WeChat peer that owns a live session id.
   * @param {string} sessionId - the agent/session id.
   * @returns {string|null} the peer id, or null for a foreign session.
   */
  peerForSession(sessionId) {
    for (const [peerId, entry] of this.handles) {
      if (entry.sessionId === sessionId) return peerId;
    }
    return null;
  }

  /**
   * Bridge `ctx.userQuestions` (plan review, ask_user_question) to WeChat.
   *
   * This listener has to run BEFORE `@deepseek-ai/dsh-api-remotes`. That plugin
   * registers the same waterfall to forward it to a browser Client and holds
   * the request until a Client answers; a listener registered after it is never
   * reached, which is why a WeChat session's plan review used to be answered in
   * the GUI and never left the host. `prepend` puts this listener first, and
   * declining with `next()` keeps GUI sessions working exactly as before.
   */
  registerQuestionAnswerer() {
    this.ctx.effect(() =>
      this.ctx.on(
        'user-questions/request',
        (request, next) => {
          try {
            const agentId = String(request?.agent?.id || '');
            const peerId = this.peerForSession(agentId);
            if (!peerId) return next();
            // A disconnected bridge must never swallow a question: leave it to
            // the GUI card so the human can still answer it somewhere.
            if (this.status?.phase !== 'connected') {
              this.log('warn', `微信未连接，提问（会话 ${agentId}）交给 GUI`);
              return next();
            }
            this.log('info', `微信接管提问：会话 ${agentId} peer=${peerId}（GUI 卡片保留）`);
            return this.askWechat(peerId, request, next);
          } catch (error) {
            this.log('warn', `微信提问桥接失败：${String(error)}`);
            return next();
          }
        },
        { prepend: true },
      ),
    );
  }

  /**
   * Send one blocking question to WeChat and race it against the GUI card.
   *
   * `next()` keeps the browser Client in the loop: `@deepseek-ai/dsh-api-remotes`
   * forwards the same waterfall to it, so the GUI still renders the plan review
   * (with the detailed plan) while WeChat gets the question and its options.
   * The first answer wins and the other side is told so.
   *
   * @param {string} peerId - the WeChat peer.
   * @param {{questions: object[], signal?: AbortSignal}} request - the user-questions request.
   * @param {() => Promise<{answers: object[]}>} [next] - the rest of the waterfall (GUI).
   * @returns {Promise<{answers: object[]}>} the structured answer batch.
   */
  askWechat(peerId, request, next) {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    const question = questions[0];
    if (!question) return Promise.resolve({ answers: [] });

    const token = this.contextTokens.get(peerId) || '';
    const options = Array.isArray(question.options) ? question.options : [];
    const signal = request?.signal;

    // One blocking question per peer: retire the previous waiter explicitly so
    // its tool call is not left hanging when a new question replaces it.
    const previous = this.pendingQuestions.get(peerId);
    if (previous) {
      this.pendingQuestions.delete(peerId);
      clearTimeout(previous.timer);
      previous.cancel('已被新问题替代');
    }

    const heading = ['📋 待确认'];
    if (question.header) heading.push(`【${question.header}】`);
    heading.push(String(question.question || ''));
    this.sendText(peerId, heading.join('\n'), token);

    // Only the question and its options go to WeChat: the detailed plan stays
    // in the GUI card, where it is rendered as markdown.
    if (options.length) {
      const lines = options.map(
        (option, index) =>
          `${index + 1}. ${option.label}${option.description ? `（${option.description}）` : ''}`,
      );
      lines.push('', '回复数字选择，0 取消。');
      this.sendText(peerId, lines.join('\n'), token);
    } else {
      this.sendText(peerId, '直接回复内容作为反馈，0 取消。', token);
    }

    const answersFor = (selected, custom) => ({
      answers: questions.map((item, index) => {
        if (index === 0) return { id: item.id, selected, ...(custom === undefined ? {} : { custom }) };
        const first = Array.isArray(item.options) && item.options[0] ? item.options[0].label : undefined;
        return first ? { id: item.id, selected: [first] } : { id: item.id, selected: [] };
      }),
    });

    const local = new Promise((resolve, reject) => {
      let settled = false;
      let entry;
      const release = () => {
        settled = true;
        if (this.pendingQuestions.get(peerId) === entry) this.pendingQuestions.delete(peerId);
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const finish = (selected, custom) => {
        if (settled) return;
        release();
        resolve(answersFor(selected, custom));
      };
      const fail = (reason) => {
        if (settled) return;
        release();
        reject(reason);
      };
      // The host owns the deadline (`askTimed`): when it aborts, this wait has
      // to settle too, or the tool would hang on a promise nobody resolves.
      const onAbort = () => {
        this.sendText(peerId, '⏰ 提问已超时或作废，继续发消息即可。', token);
        fail(signal?.reason instanceof Error ? signal.reason : new Error('user question was cancelled'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        this.log('warn', `微信提问超时（${QUESTION_TIMEOUT_MS}ms）：${String(question.id || '')} peer=${peerId}`);
        this.sendText(peerId, '⏰ 等待确认超时，已按「继续规划」处理。', token);
        finish([], '超时未确认');
      }, QUESTION_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      entry = {
        question,
        options,
        timer,
        token,
        settle: (selected, custom) => finish(selected, custom),
        cancel: (feedback) => finish([], feedback),
        // The other side won: stop waiting here and say so, without answering.
        abandon: (notice) => {
          if (settled) return;
          this.sendText(peerId, notice, token);
          release();
          resolve(answersFor([]));
        },
      };
      this.pendingQuestions.set(peerId, entry);

      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
    });

    if (typeof next !== 'function') return local;

    // Both sides are live; the first answer wins and the loser is dismissed.
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback) => (value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const succeed = settle(resolve);
      const fail = settle(reject);
      local.then(
        (answer) => {
          if (settled) return;
          succeed(answer);
          this.log('info', `提问已在微信作答：会话 ${String(request?.agent?.id || '')}`);
        },
        (error) => fail(error),
      );
      Promise.resolve()
        .then(() => next())
        .then(
          (answer) => {
            if (settled) return;
            succeed(answer);
            const entry = this.pendingQuestions.get(peerId);
            if (entry) entry.abandon('✅ 已在客户端作答，微信这边不再等待。');
            this.log('info', `提问已在客户端作答：会话 ${String(request?.agent?.id || '')}`);
          },
          (error) => {
            // The GUI channel ending is not the question ending: WeChat stays
            // answerable, and the host deadline still bounds the wait.
            this.log('warn', `GUI 提问通道结束，微信继续等待：${String(error?.message || error)}`);
          },
        );
    });
  }

  /**
   * Consume one reply as the answer to the blocking question, when present.
   * @param {string} peerId - the WeChat peer.
   * @param {string} text - the trimmed inbound text.
   * @param {string} contextToken - the conversation token of this message.
   * @returns {boolean} whether the message was consumed.
   */
  answerPendingQuestion(peerId, text, contextToken) {
    const entry = this.pendingQuestions.get(peerId);
    if (!entry) return false;
    const token = contextToken || entry.token || '';

    if (!/^\d+$/.test(text)) {
      this.pendingQuestions.delete(peerId);
      clearTimeout(entry.timer);
      this.sendText(peerId, '✅ 已提交反馈，等待计划更新。', token);
      entry.settle([], text);
      return true;
    }

    const index = Number(text);
    if (index === 0) {
      this.pendingQuestions.delete(peerId);
      clearTimeout(entry.timer);
      this.sendText(peerId, '已取消，继续规划。', token);
      entry.settle([], '用户取消');
      return true;
    }

    const option = entry.options[index - 1];
    if (!option) {
      this.sendText(peerId, `⚠️ 编号超出范围（1–${entry.options.length}），回复 0 取消。`, token);
      return true;
    }

    this.pendingQuestions.delete(peerId);
    clearTimeout(entry.timer);
    this.sendText(peerId, `✅ 已选择：${option.label}`, token);
    entry.settle([option.label]);
    return true;
  }

  // ---------------------------------------------------------- choice lists

  renderChoices(title, items, note) {
    const lines = [title];
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.label}${item.current ? '  ← 当前' : ''}`);
    });
    lines.push('', note || '回复数字选择，0 取消；发送其他内容也会取消。');
    return lines.join('\n');
  }

  setChoices(peerId, kind, items) {
    this.pendingChoices.set(peerId, { kind, items, createdAt: Date.now() });
  }

  activeChoices(peerId) {
    const pending = this.pendingChoices.get(peerId);
    if (!pending) return null;
    if (Date.now() - pending.createdAt > CHOICE_TTL_MS) {
      this.pendingChoices.delete(peerId);
      return null;
    }
    return pending;
  }

  clearChoices(peerId) {
    this.pendingChoices.delete(peerId);
  }

  /**
   * Interpret a numeric reply against this peer's outstanding choice list.
   * Non-numeric text returns null so it keeps flowing as a normal message.
   * @param {string} peerId - the WeChat peer.
   * @param {string} text - the trimmed inbound text.
   * @returns {Promise<string|null>} reply text, or null when not an answer.
   */
  async takeChoice(peerId, text) {
    const pending = this.activeChoices(peerId);
    if (!pending) return null;
    if (!/^\d+$/.test(text)) {
      // Anything that is not a number cancels the list; the caller sends the
      // receipt and then keeps processing the message normally.
      this.pendingChoices.delete(peerId);
      return { handled: false, text: '已取消上一条选择。' };
    }
    const index = Number(text);
    if (index === 0) {
      this.pendingChoices.delete(peerId);
      return { handled: true, text: '已取消。' };
    }
    const item = pending.items[index - 1];
    if (!item) {
      return {
        handled: true,
        text: `⚠️ 编号超出范围（1–${pending.items.length}），回复 0 取消；未做任何更改。`,
      };
    }
    this.pendingChoices.delete(peerId);
    return { handled: true, text: await this.applyChoice(peerId, pending.kind, item.value) };
  }

  async applyChoice(peerId, kind, value) {
    if (kind === 'perm') {
      this.saveConfig({ permission: value });
      return this.withCard(this.applyPermissionToPeer(peerId, value), null);
    }
    if (kind === 'think') {
      const next = value ? String(value) : '';
      this.saveConfig({ reasoningEffort: next });
      const sessionId = this.newSession(peerId);
      const text = next
        ? `✅ 思考等级已切换为 ${next}（已开启新会话）`
        : '✅ 思考等级已恢复默认（已开启新会话）';
      return this.withCard(text, sessionId);
    }
    if (kind === 'model') {
      const text = String(value);
      const slash = text.indexOf('/');
      if (slash > 0) {
        this.saveConfig({ provider: text.slice(0, slash), model: text.slice(slash + 1) });
      } else {
        this.saveConfig({ model: text });
      }
      const sessionId = this.newSession(peerId);
      return this.withCard(`✅ 模型已切换为 ${text}（已开启新会话）`, sessionId);
    }
    if (kind === 'cwd') {
      // Runtime-only: the settings page owns `config.cwd`, WeChat only changes
      // where this run's sessions are created.
      this.activeCwd = value;
      const sessionId = this.newSession(peerId);
      return this.withCard(
        `✅ 工作区已切换（仅本次运行）：\n${value}\n（已开启新会话；设置里的默认工作目录不变）`,
        sessionId,
      );
    }
    if (kind === 'chat') {
      const target = String(value || '');
      if (!target) return '⚠️ 目标会话无效。';
      const current = this.sessionIdFor(peerId);
      if (target === current) return '已经是这个会话了。';
      this.activeSessions.set(peerId, target);
      await this.ensureGrouped(target);
      const entry = this.handles.get(peerId);
      if (entry) {
        this.handles.delete(peerId);
        if (entry.owned) entry.handle.dispose().catch(() => {});
      }
      this.log('info', `切换会话：${current} -> ${target}`);
      return `✅ 已切换会话\n${target}\n（下一条消息进入该会话）`;
    }
    return null;
  }

  applyPermissionToPeer(peerId, value) {
    const entry = this.handles.get(peerId);
    const session = entry?.handle?.agent?.session;
    const service = this.ctx.get('permissionPresets');
    if (session && typeof service?.set === 'function') {
      try {
        service.set(session, value);
        return `✅ 会话权限已切换为 ${value}（当前会话立即生效）`;
      } catch (error) {
        return `✅ 已保存为 ${value}，但当前会话应用失败：${String(error?.message || error)}\n（下个会话生效）`;
      }
    }
    return `✅ 会话权限已保存为 ${value}（下个会话生效）`;
  }

  async routeCommand(peerId, text) {
    if (!text.startsWith('/')) return null;
    // Any new command invalidates a previous numbered list: otherwise a digit
    // sent after /帮助 would still answer the list an older command produced.
    this.clearChoices(peerId);
    const parts = text.split(/\s+/);
    const rawName = parts[0].toLowerCase();
    const name = COMMAND_ALIASES[rawName] ?? rawName;
    const arg = parts.slice(1).join(' ').trim();

    if (name === 'help') {
      return [
        '🤖 DeepSeek Harness 微信助手',
        '直接发消息即可对话（使用本机 DSH agent 的插件与提示词）。',
        '',
        '命令',
        '  /帮助   /help       帮助',
        '  /状态   /status     查看连接与参数',
        '  /重置   /reset      开启新对话',
        '  /会话   /sessions   列出会话并选择',
        '  /模型   /model      列出模型并选择',
        '  /思考   /think      列出等级并选择',
        '  /计划   /plan       切换计划模式',
        '  /工作区  /ws        列出 / 新增 / 切换',
        '  /权限   /perm       列出权限并选择',
      ].join('\n');
    }

    if (name === 'status') return await this.statusText(peerId);

    if (name === 'reset') {
      const sessionId = this.newSession(peerId);
      return this.withCard('✅ 已开启全新对话', sessionId);
    }

    if (name === 'model') {
      const { provider, model } = this.selectionOf();
      const wantList = !arg || arg.toLowerCase() === 'list' || arg === '列表';
      if (wantList) {
        const options = await this.modelChoices();
        if (!options.length) {
          return [
            `🧠 当前模型：${model || '（跟随 profile 默认）'}`,
            '（没有可列出的模型；可直接用 /模型 <模型id> 或 /模型 <provider>/<模型id>）',
          ].join('\n');
        }
        const items = options.map((option) => ({
          label: `${option.provider}/${option.model}`,
          value: `${option.provider}/${option.model}`,
          current: option.model === model && (!provider || option.provider === provider),
        }));
        this.setChoices(peerId, 'model', items);
        return this.renderChoices(`🧠 当前模型：${model || '（profile 默认）'}`, items);
      }
      if (/^\d+$/.test(arg)) {
        const pending = this.activeChoices(peerId);
        if (pending?.kind === 'model') return this.takeChoice(peerId, arg);
        const options = await this.modelChoices();
        const pick = options[Number(arg) - 1];
        if (!pick) return `⚠️ 编号超出范围（1–${options.length || 0}）`;
        return this.applyChoice(peerId, 'model', `${pick.provider}/${pick.model}`);
      }
      const slash = arg.indexOf('/');
      this.clearChoices(peerId);
      if (slash > 0) {
        const nextProvider = arg.slice(0, slash).trim();
        const nextModel = arg.slice(slash + 1).trim();
        if (!nextProvider || !nextModel) return '⚠️ 用法：/模型 <模型id> 或 /模型 <provider>/<模型id>';
        return this.applyChoice(peerId, 'model', `${nextProvider}/${nextModel}`);
      }
      return this.applyChoice(peerId, 'model', arg);
    }

    if (name === 'think') {
      const current = this.config.reasoningEffort;
      if (!arg || arg.toLowerCase() === 'list' || arg === '列表') {
        const efforts = await this.thinkEfforts();
        if (!efforts.length) {
          return [
            `💭 当前思考等级：${current || '默认'}`,
            '（当前模型没有声明可选思考等级）',
            '可直接指定：/思考 <等级>；恢复默认：/思考 默认',
          ].join('\n');
        }
        const items = efforts.map((effort) => ({
          label: effort.name && effort.name !== effort.id ? `${effort.id}（${effort.name}）` : effort.id,
          value: effort.id,
          current: effort.id === current,
        }));
        this.setChoices(peerId, 'think', items);
        return this.renderChoices(`💭 当前思考等级：${current || '默认'}`, items);
      }
      if (/^\d+$/.test(arg)) {
        const pending = this.activeChoices(peerId);
        if (pending?.kind === 'think') return this.takeChoice(peerId, arg);
        const efforts = await this.thinkEfforts();
        const pick = efforts[Number(arg) - 1];
        if (!pick) return `⚠️ 编号超出范围（1–${efforts.length || 0}）`;
        return this.applyChoice(peerId, 'think', pick.id);
      }
      this.clearChoices(peerId);
      if (['default', 'auto', 'off', 'none', '默认'].includes(arg.toLowerCase())) {
        return this.applyChoice(peerId, 'think', '');
      }
      const applied = await this.applyChoice(peerId, 'think', arg);
      return `${applied}\n（如提示不支持，请先发 /思考 查看可选值）`;
    }

    if (name === 'plan') {
      let agent;
      try {
        const entry = await this.sessionFor(peerId);
        agent = entry.handle.agent;
      } catch (error) {
        return `⚠️ 无法获取会话：${String(error?.message || error)}`;
      }
      const service = this.planService(agent);
      if (!arg) {
        if (!service) {
          return [
            '📝 计划模式：无法读取（本会话的 agent preset 没有装载计划模式）',
            '计划模式由 agent preset 提供，换到带 planning 的 preset（如 standard）后再试。',
          ].join('\n');
        }
        let state;
        try {
          state = service.get(agent);
        } catch (error) {
          return `⚠️ 无法读取计划模式：${String(error?.message || error)}`;
        }
        return [
          `📝 计划模式：${state.active ? '开启' : '关闭'}${state.pending ? '（切换待生效）' : ''}`,
          '切换：/计划 开 或 /计划 关',
        ].join('\n');
      }
      const token = arg.toLowerCase();
      const enable = ['开', '开启', 'on', 'true', '1'].includes(token);
      const disable = ['关', '关闭', 'off', 'false', '0'].includes(token);
      if (!enable && !disable) return '⚠️ 用法：/计划 开 / /计划 关';
      let result;
      try {
        result = await this.switchPlan(agent, enable);
      } catch (error) {
        return `⚠️ 切换计划模式失败：${String(error?.message || error)}`;
      }
      if (!result) {
        return [
          '⚠️ 本会话的 agent preset 没有计划模式，无法切换。',
          '计划模式由 agent preset 提供，换到带 planning 的 preset（如 standard）后再试。',
        ].join('\n');
      }
      if (result.kind === 'error') return `⚠️ 切换失败：${result.text}`;
      const label = PLAN_RESULT_LABELS[result.text] || result.text;
      return `✅ 计划模式${enable ? '开启' : '关闭'}：${label}`;
    }

    if (name === 'chat') {
      const items = await this.sessionChoices(peerId);
      if (!arg || arg === '列表') {
        if (!items.length) {
          return [
            `💬 会话（当前工作区：${this.currentCwd()}）`,
            '（当前工作区下没有会话）',
            '新增：/会话 新增',
          ].join('\n');
        }
        this.setChoices(peerId, 'chat', items);
        return this.renderChoices(
          `💬 会话（当前工作区：${this.currentCwd()}）`,
          items,
          '回复数字切换会话，0 取消；发送其他内容也会取消。新增：/会话 新增',
        );
      }
      const tokens = arg.split(/\s+/);
      const sub = CHAT_SUBCOMMANDS[tokens[0].toLowerCase()] ?? null;
      if (sub === 'new') {
        this.newSession(peerId);
        this.clearChoices(peerId);
        return this.withCard('✅ 已开启新会话', this.sessionIdFor(peerId));
      }
      if (/^\d+$/.test(arg)) {
        const pending = this.activeChoices(peerId);
        if (pending?.kind === 'chat') return this.takeChoice(peerId, arg);
        const pick = items[Number(arg) - 1];
        if (!pick) return `⚠️ 编号超出范围（1–${items.length || 0}）`;
        return this.applyChoice(peerId, 'chat', pick.value);
      }
      return '⚠️ 用法：/会话 列出并切换；/会话 新增 开启新会话';
    }

    if (name === 'workspace') {
      const list = Array.isArray(this.config.workspaces) ? this.config.workspaces : [];
      const current = this.currentCwd();
      const items = this.workspaceChoices();
      if (!arg) {
        if (!items.length) {
          return [
            '📂 工作区',
            `当前：${current}`,
            '（尚未登记其他工作区）',
            '',
            '新增并切换：/工作区 新增 <绝对路径>',
          ].join('\n');
        }
        this.setChoices(peerId, 'cwd', items);
        return this.renderChoices('📂 工作区', items, '回复数字切换，0 取消；发送其他内容也会取消。新增：/工作区 新增 <绝对路径>');
      }
      const tokens = arg.split(/\s+/);
      const sub = WORKSPACE_SUBCOMMANDS[tokens[0].toLowerCase()] ?? null;
      const rest = tokens.slice(1).join(' ').trim();

      if (sub === 'add') {
        const raw = rest;
        const cleaned = raw.replace(/^["']+|["']+$/g, '');
        if (!cleaned) return '⚠️ 用法：/工作区 新增 <绝对路径>';
        if (!isAbsolute(cleaned)) return '⚠️ 需要绝对路径，例如：/工作区 新增 D:\\projects\\demo';
        try {
          mkdirSync(cleaned, { recursive: true });
        } catch (error) {
          return `⚠️ 创建目录失败：${String(error?.message || error)}`;
        }
        const next = Array.from(new Set([...list, cleaned]));
        this.saveConfig({ workspaces: next });
        this.activeCwd = cleaned;
        const sessionId = this.newSession(peerId);
        this.clearChoices(peerId);
        return this.withCard(
          `✅ 已新增并切换（仅本次运行）：\n${cleaned}\n（已开启新会话；设置里的默认工作目录不变）`,
          sessionId,
        );
      }

      let candidate = sub === 'use' ? rest : arg;
      if (/^\d+$/.test(candidate)) {
        const pending = this.activeChoices(peerId);
        if (pending?.kind === 'cwd') return this.takeChoice(peerId, candidate);
        const pick = items[Number(candidate) - 1];
        if (!pick) return `⚠️ 编号超出范围（1–${items.length || 0}）`;
        candidate = pick.value;
      }
      const resolved = this.ensureWorkspacePath(candidate);
      if (resolved.error) return resolved.error;
      this.clearChoices(peerId);
      return this.applyChoice(peerId, 'cwd', resolved.path);
    }

    if (name === 'permission') {
      const presets = ['read-only', 'workspace-write', 'danger-full-access'];
      if (!arg) {
        const items = presets.map((value) => ({
          label: `${PERMISSION_LABELS[value]}（${value}）`,
          value,
          current: value === this.config.permission,
        }));
        this.setChoices(peerId, 'perm', items);
        return this.renderChoices(`🔐 当前会话权限：${this.config.permission}`, items);
      }
      if (/^\d+$/.test(arg)) {
        const pending = this.activeChoices(peerId);
        if (pending?.kind === 'perm') return this.takeChoice(peerId, arg);
        const pick = presets[Number(arg) - 1];
        if (!pick) return `⚠️ 编号超出范围（1–${presets.length}）`;
        return this.applyChoice(peerId, 'perm', pick);
      }
      const value = PERMISSION_ALIASES[arg] || arg.toLowerCase();
      if (!presets.includes(value)) {
        return `⚠️ 未知权限：${arg}\n可选：只读 / 写入 / 完全（或 read-only / workspace-write / danger-full-access）`;
      }
      this.clearChoices(peerId);
      return this.applyChoice(peerId, 'perm', value);
    }

    return null;
  }

  runExclusive(peerId, work) {
    const previous = this.tails.get(peerId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.tails.set(peerId, current);
    return previous
      .catch(() => {})
      .then(work)
      .finally(() => {
        release();
        if (this.tails.get(peerId) === current) this.tails.delete(peerId);
      });
  }

  // ----------------------------------------------------------------- agent

  sessionIdFor(peerId) {
    return this.activeSessions.get(peerId) || `wechat-${sanitizeId(peerId)}`;
  }

  /**
   * A session archived from the GUI is rejected by `agent/pre-step` before any
   * message reaches the model, which the user sees as "no reply". The channel
   * owns its sessions, so it lifts its own archive marker before every use.
   * @param {string} sessionId - the channel session about to be used.
   */
  async ensureUnarchived(sessionId) {
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry) return false;
    let archived = [];
    try {
      archived = registry.archivedSessionIds || [];
    } catch {
      return false;
    }
    if (!Array.isArray(archived) || !archived.includes(sessionId)) return false;
    try {
      await registry.unarchiveSession(sessionId);
      this.log('info', `会话 ${sessionId} 曾处于归档状态，已自动解除归档`);
      return true;
    } catch (error) {
      this.log('warn', `解除会话归档失败（${sessionId}）：${String(error)}`);
      return false;
    }
  }

  async sessionExists(sessionId) {
    const persistence = this.ctx.get('sessionPersistence');
    if (!persistence || typeof persistence.stat !== 'function') return false;
    try {
      return (await persistence.stat(sessionId)) !== undefined;
    } catch {
      return true;
    }
  }

  /**
   * Read one session's immutable header (cwd, createdAt) without opening it.
   * @param {string} sessionId - the session to inspect.
   * @returns {Promise<object|undefined>} the header, when the session exists.
   */
  async sessionHeader(sessionId) {
    const persistence = this.ctx.get('sessionPersistence');
    if (!persistence || typeof persistence.stat !== 'function') return undefined;
    try {
      return (await persistence.stat(sessionId))?.header;
    } catch {
      return undefined;
    }
  }

  modelOptions() {
    const selection = this.ctx.get('agentDefaultModel');
    let fallback = {};
    try {
      fallback = selection?.currentSelection?.() || {};
    } catch {
      fallback = {};
    }
    const provider = this.config.provider || fallback.provider || '';
    const model = this.config.model || fallback.model || '';
    if (!provider || !model) return {};
    const agentOptions = { provider, model };
    if (this.config.reasoningEffort) agentOptions.reasoningEffort = this.config.reasoningEffort;
    return { agentOptions };
  }

  async setupFor(agentCtx) {
    const presets = this.ctx.get('agentPresets');
    if (presets) {
      try {
        const preset = await presets.resolve();
        if (preset?.id) await presets.mount(agentCtx, preset.id);
      } catch (error) {
        this.log('warn', `挂载 agent preset 失败：${String(error)}`);
      }
    }
    if (this.config.useLocalPrompt && this.config.systemPrompt) {
      try {
        const prompt = agentCtx.get('systemPrompt');
        prompt?.section?.({
          name: 'wechat-clawbot-persona',
          order: 90,
          text: this.config.systemPrompt,
        });
      } catch (error) {
        this.log('warn', `注入微信会话提示词失败：${String(error)}`);
      }
    }
  }

  applyPermission(handle) {
    const service = this.ctx.get('permissionPresets');
    if (!service || typeof service.set !== 'function') return;
    const session = handle?.agent?.session;
    if (!session) return;
    try {
      service.set(session, this.config.permission);
    } catch (error) {
      this.log('warn', `设置会话权限失败（${this.config.permission}）：${String(error)}`);
    }
  }

  /**
   * Resolve the plan-mode service for one Agent.
   *
   * `planMode` never sits on the Host plane in a Web profile: the bundle
   * disables the root row and mounts it inside each agent preset's isolated
   * group (`isolate: {planMode: true}`). Ordinary Host lookup therefore cannot
   * see it — `ctx.get('planMode')` returns undefined by design — and only the
   * Agent's retained composition can answer.
   */
  planService(agent) {
    const direct = this.ctx.get('planMode');
    if (direct && typeof direct.get === 'function') return direct;
    const presets = this.ctx.get('agentPresets');
    if (!presets || typeof presets.serviceFor !== 'function') return undefined;
    try {
      const scoped = presets.serviceFor(agent, 'planMode');
      return scoped && typeof scoped.get === 'function' ? scoped : undefined;
    } catch (error) {
      this.log('warn', `读取 agent preset 里的 planMode 失败：${String(error?.message || error)}`);
      return undefined;
    }
  }

  /**
   * Switch plan mode for one Agent.
   *
   * The Web UI switches plan mode by running the `/plan` command rather than
   * calling the service, because the service lives outside the Host plane. Use
   * the same path: the run is logged, the GUI plan chip follows along, and the
   * per-agent command scope resolves the right preset instance. The direct
   * `set()` call stays as a fallback for a composition without `commands`.
   */
  async switchPlan(agent, enable) {
    const commands = this.ctx.get('commands');
    let commandAvailable = false;
    try {
      commandAvailable = Boolean(commands?.find?.(agent, 'plan'));
    } catch {
      commandAvailable = false;
    }
    if (commandAvailable && typeof commands.execute === 'function') {
      const execution = await commands.execute(
        agent,
        enable ? '/plan' : '/plan off',
        [],
        new AbortController().signal,
      );
      if (execution?.result) {
        this.log(
          'info',
          `计划模式走 /plan 命令：${enable ? '开' : '关'} → ${execution.result.kind} ${execution.result.text || ''}`,
        );
        return execution.result;
      }
    }
    const service = this.planService(agent);
    if (!service || typeof service.set !== 'function') return undefined;
    const outcome = service.set(agent, enable);
    this.log('info', `计划模式走 preset 服务：${enable ? '开' : '关'} → ${outcome}`);
    const texts = {
      committed: enable ? 'Plan mode on. Use /plan off to leave.' : 'Plan mode off.',
      queued: enable
        ? 'Entering plan mode (applies from the next step). Use /plan off to leave.'
        : 'Leaving plan mode (applies from the next step).',
      cancelled: 'Plan mode entry cancelled.',
      noop: enable ? 'Plan mode is already active.' : 'Plan mode is already inactive.',
    };
    return { kind: 'success', text: texts[outcome] || String(outcome) };
  }

  async sessionFor(peerId) {
    const agents = this.ctx.get('agents');
    if (!agents) throw new Error('当前 profile 没有 agents 服务，无法创建微信会话');
    const sessionId = this.sessionIdFor(peerId);
    // Run before the cached-handle shortcut: an archived live session would
    // otherwise keep being rejected by agent/pre-step.
    await this.ensureUnarchived(sessionId);
    // A restart forgets `activeSessions`, so the stable default id points at the
    // session an earlier run used. Never resume it: open a fresh session and
    // leave the old one on disk, reachable through /会话.
    const chosenHere = this.activeSessions.has(peerId) || this.handles.has(peerId);
    if (!chosenHere && (await this.sessionExists(sessionId))) {
      this.log('info', `启动后不续用上次的会话 ${sessionId}，改开新会话`);
      this.newSession(peerId);
      void this.ensureGrouped(sessionId);
      return this.sessionFor(peerId);
    }
    // A default id may also point at a session created in another workspace
    // (the settings' directory changed between runs). Never resume that one
    // either: start a fresh session in the current workspace instead.
    const header = await this.sessionHeader(sessionId);
    if (header?.cwd && normalizePath(header.cwd) !== normalizePath(this.currentCwd())) {
      this.log(
        'warn',
        `会话 ${sessionId} 属于 ${header.cwd}，与当前工作区 ${this.currentCwd()} 不一致，改开新会话`,
      );
      this.newSession(peerId);
      return this.sessionFor(peerId);
    }
    const cached = this.handles.get(peerId);
    if (cached && cached.sessionId === sessionId) {
      const stillLive = cached.owned ? Boolean(agents.get?.(sessionId)) : Boolean(cached.handle?.agent);
      if (stillLive) return cached;
      this.handles.delete(peerId);
    } else if (cached) {
      this.handles.delete(peerId);
      if (cached.owned) cached.handle.dispose().catch(() => {});
    }

    // A session the GUI already opened stays live: reuse that agent instead of
    // resuming (or closing) it, so both clients can talk to the same session.
    const live = agents.get?.(sessionId);
    if (live) {
      const entry = { sessionId, handle: { agent: live, dispose: async () => {} }, owned: false };
      this.handles.set(peerId, entry);
      this.log('info', `复用已打开的会话 ${sessionId}`);
      return entry;
    }

    const cwd = this.currentCwd();
    mkdirSync(cwd, { recursive: true });

    const options = this.modelOptions();
    const presets = this.ctx.get('agentPresets');
    let presetId = '';
    if (presets) {
      try {
        presetId = (await presets.resolve())?.id || '';
      } catch {
        presetId = '';
      }
    }
    const meta = { cwd, ...(presetId ? { agentPreset: presetId } : {}) };
    const setup = (agentCtx) => this.setupFor(agentCtx);

    let handle;
    if (await this.sessionExists(sessionId)) {
      handle = await agents.resume({ resumeSessionId: sessionId, ...options, setup });
      this.log('info', `恢复会话 ${sessionId}`);
      await this.ensureGrouped(sessionId);
    } else {
      handle = await agents.create({ sessionId, ...options, meta, setup });
      this.applyPermission(handle);
      this.log('info', `创建会话 ${sessionId}`);
      await this.ensureGrouped(sessionId);
    }

    const entry = { sessionId, handle, owned: true };
    this.handles.set(peerId, entry);
    return entry;
  }

  expectTurn(sessionId) {
    const waiter = { texts: [], settle: null, promise: null };
    waiter.promise = new Promise((resolve) => {
      waiter.settle = resolve;
    });
    const timer = setTimeout(() => {
      this.finishWaiter(sessionId, { text: '', reason: 'timeout' });
    }, Math.max(30, Number(this.config.replyTimeoutS) || 1800) * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    waiter.timer = timer;
    this.waiters.set(sessionId, waiter);
    return waiter.promise;
  }

  finishWaiter(sessionId, outcome) {
    const waiter = this.waiters.get(sessionId);
    if (!waiter) return;
    this.waiters.delete(sessionId);
    clearTimeout(waiter.timer);
    waiter.settle(outcome);
  }

  onSessionEvent(sessionId, event) {
    const waiter = this.waiters.get(sessionId);
    if (!waiter) return;
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('');
        if (text) waiter.texts.push(text);
      }
      return;
    }
    if (event?.type === 'turn/end') {
      const kind = event.data?.reason?.kind || 'completed';
      const text = [...waiter.texts].reverse().find((item) => item && item.trim()) || '';
      this.finishWaiter(sessionId, { text, reason: kind });
    }
  }

  disposeAgents() {
    for (const [peerId, entry] of this.handles) {
      this.handles.delete(peerId);
      try {
        entry.handle.dispose().catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------- HTTP

  qrSvg(url) {
    if (!url) return null;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(String(url));
      qr.make();
      return qr.createSvgTag({ cellSize: 6, margin: 3, alt: 'WeChat login QR' });
    } catch (error) {
      this.log('warn', `生成二维码失败：${String(error)}`);
      return null;
    }
  }

  async readJson(request) {
    try {
      const text = await request.text();
      if (!text) return {};
      const value = JSON.parse(text);
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  statusPayload() {
    return {
      plugin: PLUGIN_ID,
      version: PLUGIN_VERSION,
      running: Boolean(this.child),
      ...this.status,
      // The raw account id never leaves the Host process.
      accountId: maskAccount(this.status.accountId),
      config: publicConfig(this.config),
      bridgeLog: this.readBridgeLogTail(40),
      updatedAt: nowIso(),
    };
  }

  mountRoutes() {
    const mounting = this.ctx.inject(['connection'], (injected) => {
      const connection = injected.get('connection');
      const fetchApi = connection?.fetch;
      if (!fetchApi || typeof fetchApi.register !== 'function') {
        this.log('warn', '当前部署没有 connection.fetch，插件页将无法加载数据');
        return;
      }
      injected.effect(() => {
        const disposers = [];
        const route = (path, methods, handler) => {
          disposers.push(
            fetchApi.register({
              path: `${API_PREFIX}${path}`,
              methods,
              requestBody: 'buffered',
              fetch: async (request) => {
                try {
                  return await handler(request);
                } catch (error) {
                  this.log('error', `${path} 处理失败：${String(error)}`);
                  return jsonResponse({ error: String(error?.message || error) }, 500);
                }
              },
            }),
          );
        };

        route('/status', ['GET'], async () => jsonResponse(this.statusPayload()));

        route('/about', ['GET'], async () =>
          jsonResponse({
            name: PLUGIN_ID,
            version: PLUGIN_VERSION,
            license: PLUGIN_LICENSE,
            description: 'WeChat ClawBot (iLink) bridge for DeepSeek Harness',
          }),
        );

        route('/qr.svg', ['GET'], async () => {
          const svg = this.qrSvg(this.status.qrcodeUrl);
          if (!svg) return textResponse('no qr', 404);
          return textResponse(svg, 200, 'image/svg+xml; charset=utf-8');
        });

        route('/begin', ['POST'], async () => {
          await this.restart({ delayMs: 300 });
          return jsonResponse(this.statusPayload());
        });

        route('/restart', ['POST'], async () => {
          await this.restart({ delayMs: 300 });
          return jsonResponse(this.statusPayload());
        });

        route('/verify-code', ['POST'], async (request) => {
          const body = await this.readJson(request);
          const code = String(body.code || '').trim();
          if (!code) return jsonResponse({ error: '配对码不能为空' }, 400);
          const ok = this.bridgeSend({ type: 'verify-code', code });
          return jsonResponse({ ok, status: this.statusPayload() });
        });

        route('/logout', ['POST'], async () => {
          await this.logout();
          return jsonResponse(this.statusPayload());
        });

        route('/config', ['GET', 'POST'], async (request) => {
          if ((request.method || 'GET').toUpperCase() === 'GET') {
            return jsonResponse({ config: publicConfig(this.config) });
          }
          const body = await this.readJson(request);
          const patch = body.config && typeof body.config === 'object' ? body.config : body;
          const before = this.config;
          const next = this.saveConfig(patch);
          // The settings page owns the default directory; a change there drops
          // the runtime override so the new default applies from now on.
          if (next.cwd !== before.cwd) this.activeCwd = null;
          const mustRestart =
            next.logLevel !== before.logLevel ||
            next.longPollTimeoutS !== before.longPollTimeoutS ||
            JSON.stringify(next.allowFrom) !== JSON.stringify(before.allowFrom) ||
            next.pythonPath !== before.pythonPath;

          if (next.enabled !== before.enabled) {
            if (next.enabled) this.start();
            else this.stop();
          } else if (mustRestart) {
            await this.restart({ delayMs: 200 });
          }
          return jsonResponse({ ok: true, restartRequired: false, config: publicConfig(this.config), status: this.statusPayload() });
        });

        route('/logs', ['GET'], async (request) => {
          const url = new URL(request.url, 'http://localhost');
          const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 200, 10), 600);
          return jsonResponse({
            lines: this.lines.slice(-tail),
            bridgeLog: this.readBridgeLogTail(tail),
          });
        });

        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* ignore */
            }
          }
        };
      });
    });
    Promise.resolve(mounting).catch((error) => {
      this.log('warn', `注册插件页路由失败：${String(error)}`);
    });
  }

  // ---------------------------------------------------------------- start-up

  startIfEnabled() {
    if (!this.config.enabled) {
      this.setStatus({ phase: 'disabled', message: '插件已关闭（enabled=false）' });
      return;
    }
    if (!this.config.autoStart) {
      this.setStatus({ phase: 'idle', message: '已就绪（未开启自动连接）' });
      return;
    }
    const timer = setTimeout(() => this.start(), 1200);
    if (typeof timer.unref === 'function') timer.unref();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.restartTimer);
    this.stop();
    this.disposeAgents();
  }
}

export const name = 'wechat-clawbot';

export function apply(ctx) {
  const plugin = new WechatClawbot(ctx);
  plugin.log('info', `插件加载（状态目录 ${plugin.dir}）`);

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      try {
        plugin.onSessionEvent(String(session.id), event);
      } catch (error) {
        plugin.log('warn', `会话事件处理失败：${String(error)}`);
      }
    }),
  );

  plugin.registerQuestionAnswerer();
  plugin.mountRoutes();
  plugin.startIfEnabled();

  ctx.effect(() => () => {
    plugin.dispose();
  });
}
