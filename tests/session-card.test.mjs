import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env.DSH_HOME;

async function makePlugin(t) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-card-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const { WechatClawbot } = await import('../index.js');
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
    inject: () => {},
  };
  const plugin = new WechatClawbot(ctx);
  plugin.log = () => {};
  return { plugin, home };
}

const peer = 'peer@im.wechat';

test('session card lists workspace, model, effort, permission, persona and reply state', async (t) => {
  const { plugin, home } = await makePlugin(t);
  plugin.saveConfig({
    provider: 'p1',
    model: 'm1',
    reasoningEffort: 'high',
    permission: 'workspace-write',
    cwd: home,
  });

  const card = plugin.sessionCardText();
  assert.match(card, /🧭 会话参数/);
  assert.match(card, new RegExp(`工作区：${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(card, /模型：m1（p1）/);
  assert.match(card, /思考等级：high/);
  assert.match(card, /权限：workspace-write/);
  assert.match(card, /人设：本机提示词/);
  assert.match(card, /本地回复：开启/);
});

test('switching the model appends the card and marks the new session announced', async (t) => {
  const { plugin } = await makePlugin(t);
  const before = plugin.greeted.size;
  const reply = await plugin.routeCommand(peer, '/model p1/m2');
  assert.match(reply, /模型已切换为 p1\/m2/);
  assert.match(reply, /会话参数/);
  assert.equal(plugin.greeted.size, before + 1);
  assert.ok(plugin.greeted.has(plugin.sessionIdFor(peer)));
});

test('the card can be switched off', async (t) => {
  const { plugin } = await makePlugin(t);
  plugin.saveConfig({ announceSession: false });
  const reply = await plugin.routeCommand(peer, '/think low');
  assert.match(reply, /思考等级已切换为 low/);
  assert.doesNotMatch(reply, /会话参数/);
});

test('permission changes show the card without consuming an announcement', async (t) => {
  const { plugin } = await makePlugin(t);
  const before = plugin.greeted.size;
  const reply = await plugin.routeCommand(peer, '/perm read-only');
  assert.match(reply, /read-only/);
  assert.match(reply, /会话参数/);
  assert.equal(plugin.greeted.size, before);
});

test('reset announces the fresh session', async (t) => {
  const { plugin } = await makePlugin(t);
  const reply = await plugin.routeCommand(peer, '/重置');
  assert.match(reply, /已开启全新对话/);
  assert.match(reply, /会话参数/);
  assert.ok(plugin.greeted.has(plugin.sessionIdFor(peer)));
});
