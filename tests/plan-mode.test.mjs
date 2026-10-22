import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env.DSH_HOME;

/**
 * The real composition never publishes `planMode` on the Host plane: a Web
 * profile disables the root row and mounts it inside the agent preset's
 * isolated group, so only `agentPresets.serviceFor(agent, 'planMode')` and the
 * preset-scoped `/plan` command can reach it. These fakes model that shape.
 */
async function makePlugin(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-plan-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const peer = 'peer@im.wechat';
  const sessionId = 'wechat-peer_im.wechat';
  const agent = { id: sessionId, session: { id: sessionId }, ctx: {} };
  const state = { active: false };
  const calls = [];
  const executed = [];
  const presetPlanMode = {
    get: () => ({ active: state.active }),
    set: (_agent, active) => {
      calls.push(active);
      state.active = active;
      return 'committed';
    },
  };
  const commands = options.withCommands === false
    ? undefined
    : {
        find: (_agent, name) => (name === 'plan' ? { name: 'plan' } : undefined),
        execute: async (_agent, line) => {
          executed.push(line);
          const active = line.trim() === '/plan';
          calls.push(active);
          state.active = active;
          return {
            commandId: 'command-1',
            result: {
              kind: 'success',
              text: active ? 'Plan mode on. Use /plan off to leave.' : 'Plan mode off.',
            },
          };
        },
      };
  const agentPresets = options.withPresetLookup === false
    ? undefined
    : { serviceFor: (_agent, name) => (name === 'planMode' ? presetPlanMode : undefined) };
  // A root-plane service only exists in non-Web compositions.
  const rootPlanMode = options.rootPlanMode ? presetPlanMode : undefined;
  const agents = { get: (id) => (id === sessionId ? agent : undefined) };
  const { WechatClawbot } = await import('../index.js');
  const ctx = {
    get: (name) => {
      if (name === 'planMode') return rootPlanMode;
      if (name === 'agentPresets') return agentPresets;
      if (name === 'commands') return commands;
      if (name === 'agents') return agents;
      return undefined;
    },
    on: () => () => {},
    effect: () => () => {},
    inject: () => {},
  };
  const plugin = new WechatClawbot(ctx);
  plugin.log = () => {};
  plugin.sendText = () => {};
  plugin.handles.set(peer, { sessionId, handle: { agent, dispose: async () => {} }, owned: false });
  return { plugin, peer, state, calls, executed };
}

test('/计划 reports the mode from the preset-scoped service', async (t) => {
  const { plugin, peer } = await makePlugin(t);
  const text = await plugin.routeCommand(peer, '/计划');
  assert.match(text, /计划模式：关闭/);
  assert.match(text, /\/计划 开/);
});

test('/计划 finds plan mode even though the Host plane has none', async (t) => {
  const { plugin, peer, state } = await makePlugin(t);
  state.active = true;
  const text = await plugin.routeCommand(peer, '/计划');
  assert.match(text, /计划模式：开启/);
});

test('/计划 开 runs the /plan command and reports a receipt', async (t) => {
  const { plugin, peer, state, executed } = await makePlugin(t);
  const text = await plugin.routeCommand(peer, '/计划 开');
  assert.match(text, /计划模式开启：已生效/);
  assert.deepEqual(executed, ['/plan']);
  assert.equal(state.active, true);
});

test('/计划 关 runs /plan off', async (t) => {
  const { plugin, peer, state, executed } = await makePlugin(t);
  state.active = true;
  const text = await plugin.routeCommand(peer, '/计划 关');
  assert.match(text, /计划模式关闭：已生效/);
  assert.deepEqual(executed, ['/plan off']);
  assert.equal(state.active, false);
});

test('/计划 开 falls back to the scoped set() without a commands service', async (t) => {
  const { plugin, peer, state, calls } = await makePlugin(t, { withCommands: false });
  const text = await plugin.routeCommand(peer, '/计划 开');
  assert.match(text, /计划模式开启：已生效/);
  assert.deepEqual(calls, [true]);
  assert.equal(state.active, true);
});

test('/计划 still works if plan mode ever lands on the Host plane', async (t) => {
  const { plugin, peer } = await makePlugin(t, { withPresetLookup: false, rootPlanMode: true });
  const text = await plugin.routeCommand(peer, '/计划 开');
  assert.match(text, /计划模式开启：已生效/);
});

test('/计划 rejects unknown arguments', async (t) => {
  const { plugin, peer } = await makePlugin(t);
  const text = await plugin.routeCommand(peer, '/计划 随便');
  assert.match(text, /用法/);
});

test('/计划 explains a preset without plan mode', async (t) => {
  const { plugin, peer } = await makePlugin(t, { withPresetLookup: false, withCommands: false });
  const text = await plugin.routeCommand(peer, '/计划');
  assert.match(text, /没有装载计划模式/);
  const switched = await plugin.routeCommand(peer, '/计划 开');
  assert.match(switched, /agent preset 没有计划模式/);
});

test('/计划 surfaces a plan-mode command error', async (t) => {
  const peer = 'peer@im.wechat';
  const sessionId = 'wechat-peer_im.wechat';
  const agent = { id: sessionId, session: { id: sessionId }, ctx: {} };
  const { WechatClawbot } = await import('../index.js');
  const ctx = {
    get: (name) => {
      if (name === 'agents') return { get: () => agent };
      if (name === 'commands') {
        return {
          find: () => ({ name: 'plan' }),
          execute: async () => ({ commandId: 'c', result: { kind: 'error', text: 'boom' } }),
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
  plugin.sendText = () => {};
  plugin.handles.set(peer, { sessionId, handle: { agent, dispose: async () => {} }, owned: false });
  const text = await plugin.routeCommand(peer, '/计划 开');
  assert.match(text, /切换失败：boom/);
});
