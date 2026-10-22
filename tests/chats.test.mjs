import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env.DSH_HOME;

async function makePlugin(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-session-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const cwd = join(home, 'wechat-clawbot', 'workspace');
  const snapshots = typeof options.snapshots === 'function' ? options.snapshots(cwd) : options.snapshots ?? [];
  const titles = options.titles ?? new Map();
  const { WechatClawbot } = await import('../index.js');
  const ctx = {
    get: (name) => {
      if (name === 'sessionPersistence') {
        return { list: async () => snapshots, stat: async () => undefined };
      }
      if (name === 'sessionQuery') {
        return {
          readTitleSnapshots: async (ids) =>
            ids.map((id) => ({
              sessionId: id,
              status: 'fulfilled',
              value: titles.has(id)
                ? { session: { id }, title: { title: titles.get(id) } }
                : { session: { id } },
            })),
        };
      }
      return undefined;
    },
    on: () => () => {},
    effect: () => () => {},
    inject: () => {},
  };
  const plugin = new WechatClawbot(ctx);
  plugin.log = () => {};
  return { plugin, home, cwd };
}

const peer = 'peer@im.wechat';

function snapshot(id, cwd, createdAt) {
  return { header: { id, cwd, createdAt }, revision: 'r' };
}

test('/会话 lists every session in the workspace, GUI ones included', async (t) => {
  const { plugin } = await makePlugin(t, {
    snapshots: (cwd) => [
      snapshot('wechat-a', cwd, 4),
      snapshot('gui-session-1', cwd, 3),
      snapshot('other-workspace', 'D:\\elsewhere', 2),
      snapshot('wechat-b', cwd, 1),
    ],
    titles: new Map([['wechat-a', '微信助手']]),
  });

  const list = await plugin.routeCommand(peer, '/会话');
  assert.match(list, /💬 会话（当前工作区：/);
  assert.match(list, /微信助手 · /);
  assert.match(list, /gui-session-1|会话 \d+ · /);
  assert.doesNotMatch(list, /other-workspace/);
  // Newest first: wechat-a (4) before gui-session-1 (3) before wechat-b (1).
  const first = list.indexOf('微信助手');
  const last = list.lastIndexOf('· ');
  assert.ok(first > 0 && last > first);
});

test('switching a session stores its id as the active session', async (t) => {
  const { plugin } = await makePlugin(t, {
    snapshots: (cwd) => [snapshot('wechat-a', cwd, 2), snapshot('gui-session-1', cwd, 1)],
  });
  await plugin.routeCommand(peer, '/会话');

  const switched = await plugin.takeChoice(peer, '2');
  assert.match(switched.text, /已切换会话/);
  assert.match(switched.text, /gui-session-1/);
  assert.equal(plugin.sessionIdFor(peer), 'gui-session-1');
});

test('/会话 新增 creates a fresh session id and makes it active', async (t) => {
  const { plugin } = await makePlugin(t, { snapshots: [] });
  const reply = await plugin.routeCommand(peer, '/会话 新增');
  assert.match(reply, /已开启新会话/);
  assert.match(reply, /会话参数/);
  assert.match(plugin.sessionIdFor(peer), /^wechat-peer_im\.wechat__/);
});

test('an empty workspace says there are no sessions', async (t) => {
  const { plugin } = await makePlugin(t, { snapshots: [] });
  const list = await plugin.routeCommand(peer, '/会话');
  assert.match(list, /当前工作区下没有会话/);
});

test('help stays narrow: every description fits nine full-width characters', async (t) => {
  const { plugin } = await makePlugin(t);
  const help = await plugin.routeCommand(peer, '/帮助');

  const width = (text) => {
    let total = 0;
    for (const char of text) {
      total += /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1;
    }
    return total;
  };

  const rows = help.split('\n').filter((line) => /^\s{2}\//.test(line));
  assert.ok(rows.length >= 7, `unexpected help rows: ${rows.length}`);
  for (const row of rows) {
    const match = /^\s{2}\S+\s{2,}\S+\s{2,}(.+)$/.exec(row);
    assert.ok(match, `row is not aligned: ${row}`);
    const description = match[1].trim();
    assert.ok(width(description) <= 18, `description too wide (${width(description)}): ${row}`);
  }
  assert.match(help, /\/会话/);
});
