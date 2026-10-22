import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fakeReact = {
  createElement: (...args) => ({ args }),
  Fragment: 'fragment',
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};

function loadClient() {
  const registered = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        globalThis.__definition = definition;
      },
    },
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
  globalThis.document = {
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
  };
  return import(pathToFileURL(join(ROOT, 'client.js')).href).then(() => {
    const definition = globalThis.__definition;
    const mod = definition.factory((name) => (name === 'react' ? fakeReact : {}));
    const context = {
      effect: (fn) => {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      slots: {
        inject: (_slot, fn) => fn(),
        register: (options, component) => {
          registered.push({ options, component });
          return () => {};
        },
      },
    };
    mod.apply(context);
    return { definition, mod, registered };
  });
}

test('client module registers the settings page and the bundle page', async () => {
  const { definition, mod, registered } = await loadClient();
  assert.equal(definition.id, 'dsh-wechat-clawbot');
  assert.equal(typeof mod.apply, 'function');
  const slots = registered.map((entry) => entry.options.name).sort();
  assert.deepEqual(slots, ['plugins.bundle.config', 'settings.section']);
  for (const entry of registered) {
    assert.equal(typeof entry.component, 'function');
  }
  const settings = registered.find((entry) => entry.options.name === 'settings.section');
  assert.equal(settings.options.id, 'dsh-wechat-clawbot');
  assert.equal(typeof settings.options.label, 'function');
  const bundle = registered.find((entry) => entry.options.name === 'plugins.bundle.config');
  assert.equal(bundle.options.key, 'dsh-wechat-clawbot');
});
