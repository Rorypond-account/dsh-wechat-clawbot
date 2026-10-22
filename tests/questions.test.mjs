import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env.DSH_HOME;
const peer = 'peer@im.wechat';
const sessionId = 'wechat-peer_im.wechat';

/**
 * A tiny Cordis stand-in: `on` records listeners with their placement, and
 * `runWaterfall` replays the outermost-first order `ctx.waterfall` uses. That
 * order is the whole point here — the real `@deepseek-ai/dsh-api-remotes`
 * listener is registered earlier and holds the request for a browser Client,
 * so this plugin only sees it after `prepend`.
 */
async function makePlugin(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wcb-question-'));
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const listeners = [];
  const sent = [];
  const ctx = {
    get: () => undefined,
    on: (name, callback, opts) => {
      const record = { name, callback, prepend: opts?.prepend === true };
      if (record.prepend) listeners.unshift(record);
      else listeners.push(record);
      return () => {
        const index = listeners.indexOf(record);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject: () => {},
  };
  const { WechatClawbot } = await import('../index.js');
  const plugin = new WechatClawbot(ctx);
  plugin.log = (level, message) => sent.push({ kind: 'log', level, message });
  plugin.sendText = (id, text) => sent.push({ kind: 'text', peerId: id, text });
  plugin.status = { ...plugin.status, phase: options.phase || 'connected' };
  if (options.ownSession !== false) {
    plugin.handles.set(peer, { sessionId, handle: { agent: { id: sessionId } }, owned: false });
  }
  plugin.registerQuestionAnswerer();
  const runWaterfall = (request, fallback) => {
    const chain = listeners.filter((record) => record.name === 'user-questions/request');
    const step = (index) => {
      const record = chain[index];
      if (!record) return fallback(request);
      return record.callback(request, () => step(index + 1));
    };
    return step(0);
  };
  return { plugin, sent, listeners, runWaterfall };
}

function planReviewRequest(extra = {}) {
  return {
    agent: { id: sessionId },
    questions: [
      {
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: '# Plan\n\n1. Add the feature\n2. Test it',
        options: [
          { label: 'Approve plan', description: 'Leave plan mode.' },
          { label: 'Keep planning', description: 'Stay in plan mode.' },
        ],
      },
    ],
    ...extra,
  };
}

test('the answerer is prepended so it runs before the GUI forwarder', async (t) => {
  const { listeners } = await makePlugin(t);
  const records = listeners.filter((record) => record.name === 'user-questions/request');
  assert.equal(records.length, 1);
  assert.equal(records[0].prepend, true);
});

test('a WeChat session question is offered to both sides, GUI included', async (t) => {
  const { plugin, sent, runWaterfall } = await makePlugin(t);
  let guiAsked = false;
  const guiPending = new Promise(() => {});
  const pending = runWaterfall(planReviewRequest(), () => {
    guiAsked = true;
    return guiPending;
  });

  const texts = sent.filter((item) => item.kind === 'text').map((item) => item.text);
  assert.match(texts[0], /📋 待确认/);
  assert.match(texts.join('\n'), /1\. Approve plan/);
  assert.match(texts.join('\n'), /2\. Keep planning/);
  // The GUI forwarder is called on the next microtask, so give it one.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guiAsked, true);

  assert.equal(plugin.answerPendingQuestion(peer, '1', ''), true);
  assert.deepEqual((await pending).answers, [{ id: 'plan-review', selected: ['Approve plan'] }]);
});

test('only the options reach WeChat, never the detailed plan', async (t) => {
  const { plugin, sent, runWaterfall } = await makePlugin(t);
  const pending = runWaterfall(planReviewRequest(), () => new Promise(() => {}));
  const texts = sent.filter((item) => item.kind === 'text').map((item) => item.text);
  assert.equal(
    texts.some((text) => text.includes('# Plan') || text.includes('Add the feature')),
    false,
  );
  plugin.answerPendingQuestion(peer, '0', '');
  await pending;
});

test('a GUI answer wins and dismisses the WeChat prompt', async (t) => {
  const { plugin, sent, runWaterfall } = await makePlugin(t);
  const answer = await runWaterfall(planReviewRequest(), () =>
    Promise.resolve({ answers: [{ id: 'plan-review', selected: ['Approve plan'] }] }),
  );
  assert.deepEqual(answer.answers, [{ id: 'plan-review', selected: ['Approve plan'] }]);
  assert.equal(plugin.pendingQuestions.size, 0);
  const texts = sent.filter((item) => item.kind === 'text').map((item) => item.text);
  assert.match(texts.join('\n'), /已在客户端作答/);
  // A late WeChat reply must no longer be consumed as the answer.
  assert.equal(plugin.answerPendingQuestion(peer, '1', ''), false);
});

test('a rejected GUI channel leaves WeChat answerable', async (t) => {
  const { plugin, runWaterfall } = await makePlugin(t);
  const pending = runWaterfall(planReviewRequest(), () =>
    Promise.reject(new Error('no answerer')),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.pendingQuestions.has(peer), true);
  assert.equal(plugin.answerPendingQuestion(peer, '2', ''), true);
  assert.deepEqual((await pending).answers, [{ id: 'plan-review', selected: ['Keep planning'] }]);
});

test('a foreign session falls through to the GUI forwarder', async (t) => {
  const { plugin, runWaterfall, sent } = await makePlugin(t, { ownSession: false });
  let guiAsked = false;
  const request = planReviewRequest({ agent: { id: 'gui-session-1' } });
  const answer = await runWaterfall(request, () => {
    guiAsked = true;
    return Promise.resolve({ answers: [{ id: 'plan-review', selected: ['Approve plan'] }] });
  });
  assert.equal(guiAsked, true);
  assert.deepEqual(answer.answers, [{ id: 'plan-review', selected: ['Approve plan'] }]);
  assert.equal(sent.filter((item) => item.kind === 'text').length, 0);
});

test('a disconnected bridge leaves the question to the GUI', async (t) => {
  const { plugin, runWaterfall, sent } = await makePlugin(t, { phase: 'idle' });
  let guiAsked = false;
  await runWaterfall(planReviewRequest(), () => {
    guiAsked = true;
    return Promise.resolve({ answers: [] });
  });
  assert.equal(guiAsked, true);
  assert.equal(sent.filter((item) => item.kind === 'text').length, 0);
  assert.equal(plugin.pendingQuestions.size, 0);
});

test('0 cancels the review as feedback', async (t) => {
  const { plugin, runWaterfall } = await makePlugin(t);
  const pending = runWaterfall(planReviewRequest(), () => new Promise(() => {}));
  assert.equal(plugin.answerPendingQuestion(peer, '0', ''), true);
  assert.deepEqual((await pending).answers, [{ id: 'plan-review', selected: [], custom: '用户取消' }]);
});

test('free text becomes the feedback for the plan', async (t) => {
  const { plugin, runWaterfall } = await makePlugin(t);
  const pending = runWaterfall(planReviewRequest(), () => new Promise(() => {}));
  assert.equal(plugin.answerPendingQuestion(peer, '再拆细一点', ''), true);
  assert.deepEqual((await pending).answers, [
    { id: 'plan-review', selected: [], custom: '再拆细一点' },
  ]);
});

test('an out-of-range index keeps waiting', async (t) => {
  const { plugin, runWaterfall } = await makePlugin(t);
  const pending = runWaterfall(planReviewRequest(), () => new Promise(() => {}));
  assert.equal(plugin.answerPendingQuestion(peer, '9', ''), true);
  assert.equal(plugin.pendingQuestions.has(peer), true);
  plugin.answerPendingQuestion(peer, '2', '');
  assert.deepEqual((await pending).answers, [{ id: 'plan-review', selected: ['Keep planning'] }]);
});

test('the host abort settles the wait instead of hanging it', async (t) => {
  const { plugin, runWaterfall, sent } = await makePlugin(t);
  const controller = new AbortController();
  const request = planReviewRequest({ signal: controller.signal });
  const pending = runWaterfall(request, () => new Promise(() => {}));
  assert.equal(plugin.pendingQuestions.has(peer), true);

  const reason = new Error('ask_user_question timed out before the user answered');
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(plugin.pendingQuestions.has(peer), false);
  const texts = sent.filter((item) => item.kind === 'text').map((item) => item.text);
  assert.match(texts.join('\n'), /已超时或作废/);
  // A late WeChat reply must not resolve into the dead question.
  assert.equal(plugin.answerPendingQuestion(peer, '1', ''), false);
});

test('an already-aborted signal never registers a wait', async (t) => {
  const { plugin, runWaterfall } = await makePlugin(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const pending = runWaterfall(planReviewRequest({ signal: controller.signal }), () =>
    Promise.resolve({ answers: [] }),
  );
  await assert.rejects(pending, /cancelled/);
  assert.equal(plugin.pendingQuestions.size, 0);
});

test('a second question retires the first instead of overwriting it', async (t) => {
  const { plugin, runWaterfall } = await makePlugin(t);
  const first = runWaterfall(planReviewRequest(), () => new Promise(() => {}));
  const second = runWaterfall(
    {
      agent: { id: sessionId },
      questions: [
        {
          id: 'next-question',
          header: 'Pick one',
          question: 'Which way?',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    },
    () => new Promise(() => {}),
  );
  assert.deepEqual((await first).answers, [
    { id: 'plan-review', selected: [], custom: '已被新问题替代' },
  ]);
  plugin.answerPendingQuestion(peer, '2', '');
  assert.deepEqual((await second).answers, [{ id: 'next-question', selected: ['B'] }]);
});

test('only the owning session is bridged', async (t) => {
  const { plugin } = await makePlugin(t);
  assert.equal(plugin.peerForSession(sessionId), peer);
  assert.equal(plugin.peerForSession('gui-session-1'), null);
});
