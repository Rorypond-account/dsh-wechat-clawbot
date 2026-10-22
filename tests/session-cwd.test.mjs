import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env.DSH_HOME;

async function makePlugin(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-cwd-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const created = [];
  const resumed = [];
  const headers = options.headers ?? new Map();
  const agents = {
    get: () => undefined,
    create: async (request) => {
      created.push(request.sessionId);
      return { agent: { id: request.sessionId, session: { id: request.sessionId } }, dispose: async () => {} };
    },
    resume: async (request) => {
      resumed.push(request.resumeSessionId);
      return { agent: { id: request.resumeSessionId, session: { id: request.resumeSessionId } }, dispose: async () => {} };
    },
  };
  const persistence = {
    stat: async (sessionId) => {
      const header = headers.get(sessionId);
      return header === undefined ? undefined : { header };
    },
  };
  const { WechatClawbot } = await import('../index.js');
  const ctx = {
    get: (name) => {
      if (name === 'agents') return agents;
      if (name === 'sessionPersistence') return persistence;
      return undefined;
    },
    on: () => () => {},
    effect: () => () => {},
    inject: () => {},
  };
  const plugin = new WechatClawbot(ctx);
  plugin.log = () => {};
  plugin.sendText = () => {};
  return { plugin, home, created, resumed, headers };
}

const peer = 'peer@im.wechat';
const defaultId = 'wechat-peer_im.wechat';

test('a persisted default session is not resumed: a restart opens a new one', async (t) => {
  const { plugin, created, resumed, headers } = await makePlugin(t);
  const cwd = plugin.currentCwd();
  mkdirSync(cwd, { recursive: true });
  headers.set(defaultId, { id: defaultId, cwd });

  const entry = await plugin.sessionFor(peer);
  assert.notEqual(entry.sessionId, defaultId);
  assert.match(entry.sessionId, /^wechat-peer_im\.wechat__/);
  assert.deepEqual(resumed, [], 'a session from an earlier run must not be resumed');
  assert.deepEqual(created, [entry.sessionId]);
  assert.equal(plugin.sessionIdFor(peer), entry.sessionId);
});

test('the first ever session keeps the clean default id', async (t) => {
  const { plugin, created, resumed } = await makePlugin(t);
  const entry = await plugin.sessionFor(peer);
  assert.equal(entry.sessionId, defaultId);
  assert.deepEqual(created, [defaultId]);
  assert.deepEqual(resumed, []);
});

test('a session chosen in this process is resumed again', async (t) => {
  const { plugin, resumed, headers } = await makePlugin(t);
  const cwd = plugin.currentCwd();
  mkdirSync(cwd, { recursive: true });
  headers.set(defaultId, { id: defaultId, cwd });
  // `/会话` (or an earlier turn in this process) made it the active session.
  plugin.activeSessions.set(peer, defaultId);

  const entry = await plugin.sessionFor(peer);
  assert.equal(entry.sessionId, defaultId);
  assert.deepEqual(resumed, [defaultId]);
});

test('a chosen session from another workspace is replaced, not resumed', async (t) => {
  const oldCwd = join(tmpdir(), 'wcb-old-workspace');
  const { plugin, created, resumed, headers } = await makePlugin(t, {
    headers: new Map([[defaultId, { id: defaultId, cwd: oldCwd }]]),
  });
  plugin.activeSessions.set(peer, defaultId);

  const entry = await plugin.sessionFor(peer);
  assert.notEqual(entry.sessionId, defaultId);
  assert.deepEqual(resumed, [], 'the foreign-cwd session must not be resumed');
  assert.equal(created.length, 1);
});

test('/status separates the default workspace from the session workspace', async (t) => {
  const oldCwd = join(tmpdir(), 'wcb-status-old');
  const { plugin, headers } = await makePlugin(t, {
    headers: new Map([[defaultId, { id: defaultId, cwd: oldCwd }]]),
  });
  plugin.saveConfig({ cwd: join(tmpdir(), 'wcb-status-default') });

  const text = await plugin.routeCommand(peer, '/状态');
  assert.match(text, /工作区（默认）：/);
  assert.match(text, new RegExp(`工作区（会话）：${oldCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text, /提示：会话仍在旧工作区/);
});
