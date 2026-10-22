import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DSH_HOME is read through a function, so it can change per test.
const previousHome = process.env.DSH_HOME;

const llmMock = {
  listProviders: () => [{ id: 'p1', name: 'Provider One' }],
  listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
  resolveModelInfo: async () => ({
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'low',
    },
  }),
};

function makePlugin(t) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-cmd-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  return import('../index.js').then((mod) => {
    const ctx = {
      get: (name) => (name === 'llm' ? llmMock : undefined),
      on: () => () => {},
      effect: () => () => {},
      inject: () => {},
    };
    const plugin = new mod.WechatClawbot(ctx);
    plugin.log = () => {};
    return { plugin, home };
  });
}

const peer = 'peer@im.wechat';

test('/perm lists numbered presets and a digit applies one', async (t) => {
  const { plugin } = await makePlugin(t);
  const list = await plugin.routeCommand(peer, '/perm');
  assert.match(list, /1\. 只读（read-only）/);
  assert.match(list, /2\. 写入（workspace-write）/);
  assert.match(list, /3\. 完全（danger-full-access）/);
  assert.match(list, /0 取消/);
  assert.equal(plugin.activeChoices(peer)?.kind, 'perm');

  const applied = await plugin.takeChoice(peer, '3');
  assert.equal(applied.handled, true);
  assert.match(applied.text, /danger-full-access/);
  assert.equal(plugin.config.permission, 'danger-full-access');
  assert.equal(plugin.activeChoices(peer), null);
});

test('0 cancels and out-of-range keeps the list', async (t) => {
  const { plugin } = await makePlugin(t);
  await plugin.routeCommand(peer, '/perm');

  const outOfRange = await plugin.takeChoice(peer, '9');
  assert.equal(outOfRange.handled, true);
  assert.match(outOfRange.text, /超出范围/);
  assert.match(outOfRange.text, /未做任何更改/);
  assert.ok(plugin.activeChoices(peer), 'pending list must survive an invalid index');

  const cancelled = await plugin.takeChoice(peer, '0');
  assert.equal(cancelled.handled, true);
  assert.equal(cancelled.text, '已取消。');
  assert.equal(plugin.activeChoices(peer), null);
});

test('non-numeric text cancels the list and reports it', async (t) => {
  const { plugin } = await makePlugin(t);
  await plugin.routeCommand(peer, '/perm');

  const result = await plugin.takeChoice(peer, '你好');
  assert.equal(result.handled, false);
  assert.equal(result.text, '已取消上一条选择。');
  assert.equal(plugin.activeChoices(peer), null);
});

test('expired lists stop answering', async (t) => {
  const { plugin } = await makePlugin(t);
  await plugin.routeCommand(peer, '/perm');
  plugin.activeChoices(peer).createdAt -= 10 * 60 * 1000;
  assert.equal(await plugin.takeChoice(peer, '1'), null);
});

test('/think lists declared efforts and applies the pick', async (t) => {
  const { plugin } = await makePlugin(t);
  plugin.saveConfig({ provider: 'p1', model: 'm1' });
  const list = await plugin.routeCommand(peer, '/think');
  assert.match(list, /1\. low/);
  assert.match(list, /2\. high/);

  const applied = await plugin.takeChoice(peer, '2');
  assert.match(applied.text, /high/);
  assert.equal(plugin.config.reasoningEffort, 'high');
});

test('/model lists provider models and applies the pick', async (t) => {
  const { plugin } = await makePlugin(t);
  const list = await plugin.routeCommand(peer, '/model');
  assert.match(list, /1\. p1\/m1/);
  assert.match(list, /2\. p1\/m2/);

  const applied = await plugin.takeChoice(peer, '1');
  assert.match(applied.text, /p1\/m1/);
  assert.equal(plugin.config.provider, 'p1');
  assert.equal(plugin.config.model, 'm1');
});

test('/ws add then a digit switches the working directory', async (t) => {
  const { plugin, home } = await makePlugin(t);
  const workspace = join(home, 'project-a');
  const added = await plugin.routeCommand(peer, `/ws add "${workspace}"`);
  assert.match(added, /已新增并切换/);
  assert.equal(plugin.currentCwd(), workspace);

  const list = await plugin.routeCommand(peer, '/ws');
  assert.match(list, /1\. /);
  const applied = await plugin.takeChoice(peer, '1');
  assert.match(applied.text, /工作区已切换/);
});

test('direct arguments still work', async (t) => {
  const { plugin } = await makePlugin(t);
  const perm = await plugin.routeCommand(peer, '/perm read-only');
  assert.match(perm, /read-only/);
  assert.equal(plugin.config.permission, 'read-only');

  const model = await plugin.routeCommand(peer, '/model p1/m2');
  assert.match(model, /p1\/m2/);
  assert.equal(plugin.config.model, 'm2');
});

test('another command drops a pending list so digits cannot answer it', async (t) => {
  const { plugin } = await makePlugin(t);
  await plugin.routeCommand(peer, '/perm');
  assert.ok(plugin.activeChoices(peer), 'the permission list should be pending');

  await plugin.routeCommand(peer, '/帮助');
  assert.equal(plugin.activeChoices(peer), null);
  assert.equal(await plugin.takeChoice(peer, '3'), null);
  assert.equal(plugin.config.permission, 'workspace-write');
});
