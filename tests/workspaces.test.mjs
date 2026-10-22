import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env.DSH_HOME;

async function makePlugin(t, workspaces = []) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-ws-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const { WechatClawbot } = await import('../index.js');
  const registry = {
    list: () => workspaces.map((path) => ({ path })),
    get archivedSessionIds() {
      return [];
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
  return { plugin, home };
}

const peer = 'peer@im.wechat';

test('the workspace list merges GUI workspaces and always shows the current one', async (t) => {
  const { plugin, home } = await makePlugin(t, ['C:\\work\\demo', 'C:\\work\\other']);

  const list = await plugin.routeCommand(peer, '/工作区');
  const current = join(home, 'wechat-clawbot', 'workspace');
  assert.match(list, new RegExp(current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(list, /C:\\work\\demo/);
  assert.match(list, /C:\\work\\other/);
  assert.match(list, /← 当前/);
  assert.doesNotMatch(list, /尚未登记其他工作区/);
});

test('configured workspaces and registry workspaces are de-duplicated', async (t) => {
  const { plugin } = await makePlugin(t, ['C:\\work\\demo']);
  plugin.saveConfig({ workspaces: ['C:\\work\\demo', 'D:\\projects\\a'] });

  const choices = plugin.workspaceChoices();
  const paths = choices.map((entry) => entry.value);
  assert.equal(paths.filter((path) => path === 'C:\\work\\demo').length, 1);
  assert.ok(paths.includes('D:\\projects\\a'));
});

test('a numeric reply switches to a GUI workspace', async (t) => {
  const gui = join(tmpdir(), `wcb-gui-${Date.now()}`);
  mkdirSync(gui, { recursive: true });
  t.after(() => rmSync(gui, { recursive: true, force: true }));

  const { plugin } = await makePlugin(t, [gui]);
  // Index 1 is the current default workspace, index 2 the registry entry.
  const list = await plugin.routeCommand(peer, '/工作区');
  assert.match(list, /2\. /);

  const applied = await plugin.routeCommand(peer, '/工作区 2');
  assert.match(applied, /工作区已切换|已开启新会话/);
  assert.equal(plugin.currentCwd(), gui);
  assert.equal(plugin.config.cwd, '', 'WeChat must not rewrite the settings default');
});
