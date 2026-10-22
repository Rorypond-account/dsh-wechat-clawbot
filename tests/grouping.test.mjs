import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env.DSH_HOME;

async function makePlugin(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-group-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const cwd = join(home, 'wechat-clawbot', 'workspace');
  const attached = [];
  const created = [];
  const registered = new Map();
  const makeWorkspace = (path) => {
    const workspace = {
      path,
      sessionIds: [],
      attachSession: async (sessionId) => {
        attached.push(sessionId);
        workspace.sessionIds.push(sessionId);
      },
    };
    return workspace;
  };
  const registry = {
    resolveByPath: async (path) => registered.get(path),
    create: async (path, title) => {
      if (options.failCreate) throw new Error('cannot create a workspace here');
      created.push({ path, title });
      const workspace = makeWorkspace(path);
      registered.set(path, workspace);
      return workspace;
    },
    get archivedSessionIds() {
      return [];
    },
  };
  if (options.preRegistered !== false) registered.set(cwd, makeWorkspace(cwd));
  const { WechatClawbot } = await import('../index.js');
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    on: () => () => {},
    effect: () => () => {},
    inject: () => {},
  };
  const plugin = new WechatClawbot(ctx);
  plugin.log = () => {};
  plugin.sendText = () => {};
  return { plugin, home, cwd, attached, created, registered };
}

const peer = 'peer@im.wechat';

test('an existing session is attached to the workspace that owns the cwd', async (t) => {
  const { plugin, cwd, attached, created, registered } = await makePlugin(t);
  plugin.saveConfig({ cwd });

  await plugin.ensureGrouped('gui-session-1');
  assert.deepEqual(attached, ['gui-session-1']);
  assert.deepEqual(registered.get(cwd).sessionIds, ['gui-session-1']);
  assert.deepEqual(created, [], 'a registered workspace is never re-created');

  // Already grouped: no duplicate call.
  await plugin.ensureGrouped('gui-session-1');
  assert.deepEqual(attached, ['gui-session-1']);
});

test('an unregistered cwd is registered as a workspace, then attached', async (t) => {
  const { plugin, cwd, attached, created } = await makePlugin(t, { preRegistered: false });
  plugin.saveConfig({ cwd });

  await plugin.ensureGrouped('wechat-session-1');
  assert.deepEqual(created, [{ path: cwd, title: '微信 clawbot' }]);
  assert.deepEqual(attached, ['wechat-session-1']);
});

test('a workspace that cannot be registered only logs a warning', async (t) => {
  const { plugin, home, attached } = await makePlugin(t, { preRegistered: false, failCreate: true });
  plugin.saveConfig({ cwd: join(home, 'not-registrable') });

  await plugin.ensureGrouped('some-session');
  assert.deepEqual(attached, []);
  assert.equal(plugin.sessionIdFor(peer), 'wechat-peer_im.wechat');
});

test('switching a session also groups it', async (t) => {
  const { plugin, cwd, attached } = await makePlugin(t);
  plugin.saveConfig({ cwd });
  plugin.handles.set(peer, { sessionId: 'old-session', handle: { agent: {}, dispose: async () => {} }, owned: true });

  const reply = await plugin.applyChoice(peer, 'chat', 'gui-session-2');
  assert.match(reply, /已切换会话/);
  assert.deepEqual(attached, ['gui-session-2']);
  assert.equal(plugin.sessionIdFor(peer), 'gui-session-2');
});
