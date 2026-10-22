import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function makePlugin(t) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-zh-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const { WechatClawbot } = await import('../index.js');
  const ctx = {
    get: (name) => (name === 'llm' ? llmMock : undefined),
    on: () => () => {},
    effect: () => () => {},
    inject: () => {},
  };
  const plugin = new WechatClawbot(ctx);
  plugin.log = () => {};
  return { plugin, home };
}

const peer = 'peer@im.wechat';

test('Chinese help lists the Chinese commands', async (t) => {
  const { plugin } = await makePlugin(t);
  const text = await plugin.routeCommand(peer, '/帮助');
  assert.match(text, /\/模型/);
  assert.match(text, /\/思考/);
  assert.match(text, /\/工作区/);
  assert.match(text, /\/权限/);
  assert.match(text, /\/会话/);
  // The help keeps only the list-then-pick shape; direct-argument forms stay
  // available but are not advertised.
  assert.doesNotMatch(text, /<模型id>/);
  assert.doesNotMatch(text, /<绝对路径>/);
  assert.doesNotMatch(text, /使用 <编号/);
});

test('Chinese status reports workspace, model, effort and permission', async (t) => {
  const { plugin } = await makePlugin(t);
  plugin.saveConfig({ provider: 'p1', model: 'm1', reasoningEffort: 'high' });
  const text = await plugin.routeCommand(peer, '/状态');
  assert.match(text, /工作区（默认）：/);
  assert.match(text, /工作区（会话）：/);
  assert.match(text, /模型：m1（p1）/);
  assert.match(text, /思考等级：high/);
  assert.match(text, /权限：workspace-write/);
});

test('Chinese permission list and value aliases', async (t) => {
  const { plugin } = await makePlugin(t);
  const list = await plugin.routeCommand(peer, '/权限');
  assert.match(list, /1\. 只读（read-only）/);
  assert.match(list, /2\. 写入（workspace-write）/);
  assert.match(list, /3\. 完全（danger-full-access）/);

  const applied = await plugin.routeCommand(peer, '/权限 完全');
  assert.match(applied, /danger-full-access/);
  assert.equal(plugin.config.permission, 'danger-full-access');

  const numeric = await plugin.routeCommand(peer, '/权限 1');
  assert.match(numeric, /read-only/);
  assert.equal(plugin.config.permission, 'read-only');
});

test('Chinese model list and switch', async (t) => {
  const { plugin } = await makePlugin(t);
  const list = await plugin.routeCommand(peer, '/模型 列表');
  assert.match(list, /1\. p1\/m1/);
  assert.match(list, /2\. p1\/m2/);

  const picked = await plugin.takeChoice(peer, '2');
  assert.match(picked.text, /p1\/m2/);
  assert.equal(plugin.config.model, 'm2');
});

test('Chinese think list and default reset', async (t) => {
  const { plugin } = await makePlugin(t);
  plugin.saveConfig({ provider: 'p1', model: 'm1' });
  const list = await plugin.routeCommand(peer, '/思考');
  assert.match(list, /1\. low/);
  assert.match(list, /2\. high/);

  const applied = await plugin.routeCommand(peer, '/思考 high');
  assert.equal(plugin.config.reasoningEffort, 'high');

  const reset = await plugin.routeCommand(peer, '/思考 默认');
  assert.match(reset, /恢复默认|默认/);
  assert.equal(plugin.config.reasoningEffort, '');
});

test('Chinese workspace add and use', async (t) => {
  const { plugin, home } = await makePlugin(t);
  const workspace = join(home, '项目甲');
  const added = await plugin.routeCommand(peer, `/工作区 新增 "${workspace}"`);
  assert.match(added, /已新增并切换/);
  assert.equal(plugin.currentCwd(), workspace);

  const list = await plugin.routeCommand(peer, '/工作区');
  assert.match(list, /1\. /);
  const used = await plugin.routeCommand(peer, '/工作区 使用 1');
  assert.match(used, /工作区已切换/);
});

test('English aliases keep working after the Chinese rename', async (t) => {
  const { plugin } = await makePlugin(t);
  assert.match(await plugin.routeCommand(peer, '/help'), /\/帮助/);
  assert.match(await plugin.routeCommand(peer, '/perm read-only'), /read-only/);
  assert.equal(plugin.config.permission, 'read-only');
  assert.match(await plugin.routeCommand(peer, '/status'), /工作区（默认）：/);
});
