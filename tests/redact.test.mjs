import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('redact masks credentials but keeps diagnostics readable', async () => {
  const { redact } = await import('../index.js');
  assert.equal(redact('bot_token":"abcdef1234567890"'), 'bot_token":"abcd…"');
  assert.equal(redact('context_token=ZZZZ111122223333'), 'context_token=ZZZZ…');
  assert.equal(redact('Authorization: Bearer deadbeefcafe@im.bot'), 'Authorization: Bearer dead…');
  assert.equal(redact('账号 deadbeefcafe@im.bot 已连接'), '账号 dead…@im.bot 已连接');
  assert.equal(redact('no secret here'), 'no secret here');
  assert.equal(redact(new Error('token: 0123456789abcdef')), 'token: 0123…');
});

test('manifest version matches the Host constant', async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const source = readFileSync(join(ROOT, 'index.js'), 'utf8');
  const match = /const PLUGIN_VERSION = '([^']+)'/.exec(source);
  assert.ok(match, 'PLUGIN_VERSION constant is missing');
  assert.equal(match[1], manifest.version);
});

test('example config covers every default key', async () => {
  const example = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
  const source = readFileSync(join(ROOT, 'index.js'), 'utf8');
  const block = /const DEFAULT_CONFIG = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'DEFAULT_CONFIG block is missing');
  const keys = [...block[1].matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((entry) => entry[1]);
  assert.ok(keys.length > 10, `unexpected default key count: ${keys.length}`);
  for (const key of keys) {
    assert.ok(Object.hasOwn(example, key), `config.example.json is missing ${key}`);
  }
});
