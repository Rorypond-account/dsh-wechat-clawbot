import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env.DSH_HOME;

test('archived channel sessions are unarchived before use', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wcb-arc-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const { WechatClawbot } = await import('../index.js');
  const archived = new Set(['wechat-peer_im.wechat', 'wechat-other_im.wechat']);
  const calls = [];
  const registry = {
    get archivedSessionIds() {
      return [...archived];
    },
    async unarchiveSession(sessionId) {
      calls.push(sessionId);
      archived.delete(sessionId);
    },
  };
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    on: () => () => {},
    effect: () => () => {},
    inject: () => {},
  };
  const plugin = new WechatClawbot(ctx);
  plugin.log = () => {};

  assert.equal(await plugin.ensureUnarchived('wechat-peer_im.wechat'), true);
  assert.deepEqual(calls, ['wechat-peer_im.wechat']);
  assert.deepEqual(registry.archivedSessionIds, ['wechat-other_im.wechat']);

  // Already live: nothing to do and no second call.
  assert.equal(await plugin.ensureUnarchived('wechat-peer_im.wechat'), false);
  assert.equal(calls.length, 1);
});

test('a missing registry is tolerated', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wcb-arc2-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const { WechatClawbot } = await import('../index.js');
  const plugin = new WechatClawbot({ get: () => undefined, on: () => () => {}, effect: () => () => {}, inject: () => {} });
  plugin.log = () => {};
  assert.equal(await plugin.ensureUnarchived('wechat-any'), false);
});
