#!/usr/bin/env node
/**
 * One-shot repository check, dependency free.
 *
 *   1. JavaScript syntax (index.js, client.js, vendor/qrcode.mjs)
 *   2. Python syntax (bridge/*.py), skipped with a notice when Python is absent
 *   3. JSON / YAML sanity for the manifest and the bundle patch
 *   4. Client module smoke test: load client.js and assert both slot registrations
 *   5. Secret scan over every tracked-looking text file
 *
 * Exits non-zero on the first category with findings, after printing all of them.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const findings = [];
const notes = [];

function fail(section, message) {
  findings.push(`[${section}] ${message}`);
}

function ok(section, message) {
  console.log(`  ok   ${section}: ${message}`);
}

// ---------------------------------------------------------------- 1. JS syntax

const jsFiles = ['index.js', 'client.js', 'vendor/qrcode.mjs'].filter((file) => existsSync(join(ROOT, file)));
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' });
  if (result.status === 0) ok('js', file);
  else fail('js', `${file}: ${(result.stderr || '').trim().split('\n').slice(0, 3).join(' ')}`);
}

// ------------------------------------------------------------- 2. Python syntax

const pyFiles = ['bridge/host_bridge.py', 'bridge/ilink_client.py'].filter((file) => existsSync(join(ROOT, file)));
const python = process.platform === 'win32' ? 'python' : 'python3';
// Keep bytecode out of the repository: without this, py_compile drops
// `bridge/__pycache__/` next to the sources on every run.
const pythonEnv = { ...process.env, PYTHONPYCACHEPREFIX: join(tmpdir(), 'dsh-wechat-clawbot-pycache') };
const pythonCheck = spawnSync(python, ['--version'], { encoding: 'utf8' });
if (pythonCheck.status === 0) {
  for (const file of pyFiles) {
    const result = spawnSync(python, ['-m', 'py_compile', join(ROOT, file)], { encoding: 'utf8', env: pythonEnv });
    if (result.status === 0) ok('python', file);
    else fail('python', `${file}: ${(result.stderr || '').trim().split('\n').slice(0, 3).join(' ')}`);
  }
} else {
  notes.push('python not found; skipped py_compile');
}

// --------------------------------------------------------------- 3. JSON / YAML

const jsonFiles = ['package.json', 'config.example.json', 'locale/zh.json', 'locale/en.json'].filter((file) =>
  existsSync(join(ROOT, file)),
);
for (const file of jsonFiles) {
  try {
    JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    ok('json', file);
  } catch (error) {
    fail('json', `${file}: ${error.message}`);
  }
}

const patchFile = join(ROOT, 'cordis.patch.yml');
if (!existsSync(patchFile)) {
  fail('yaml', 'cordis.patch.yml is missing');
} else {
  const lines = readFileSync(patchFile, 'utf8').split(/\r?\n/);
  let problem = '';
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    // The bundle patch only needs list items and `key: value` lines.
    if (!/^-\s/.test(trimmed) && !/^[A-Za-z0-9_.'"@/-]+\s*:/.test(trimmed) && !/^-\s+[A-Za-z0-9_.-]+\s*:/.test(trimmed)) {
      problem = `line ${index + 1}: ${trimmed}`;
    }
  });
  if (problem) fail('yaml', `cordis.patch.yml: ${problem}`);
  else ok('yaml', 'cordis.patch.yml');
}

try {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const patchPath = manifest?.dsh?.bundle?.patch;
  if (!patchPath || !existsSync(join(ROOT, String(patchPath).replace(/^\.\//, '')))) {
    fail('manifest', 'dsh.bundle.patch does not point at an existing file');
  } else {
    ok('manifest', `bundle patch -> ${patchPath}`);
  }
  if (manifest.license !== 'MIT') notes.push(`package.json license is ${manifest.license}, expected MIT`);
} catch (error) {
  fail('manifest', String(error.message || error));
}

// ------------------------------------------------------ 4. Client module smoke

const registered = [];
const fakeReact = {
  createElement: (...args) => ({ args }),
  Fragment: 'fragment',
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};

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

try {
  await import(pathToFileURL(join(ROOT, 'client.js')).href);
  const definition = globalThis.__definition;
  if (!definition || definition.id !== 'dsh-wechat-clawbot') throw new Error('module definition missing');
  const mod = definition.factory((name) => (name === 'react' ? fakeReact : {}));
  if (typeof mod.apply !== 'function') throw new Error('apply() missing');
  mod.apply({
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
  });
  const names = registered.map((entry) => entry.options.name);
  if (!names.includes('settings.section') || !names.includes('plugins.bundle.config')) {
    throw new Error(`unexpected slots: ${names.join(', ') || '(none)'}`);
  }
  if (typeof registered[0].component !== 'function') throw new Error('a slot registered without a component');
  ok('client', names.join(' + '));
} catch (error) {
  fail('client', String(error.message || error));
}

// ------------------------------------------------------------- 5. Secret scan

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.py', '.json', '.md', '.yml', '.yaml', '.svg', '.txt', '.example']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build']);
const SECRET_PATTERNS = [
  { name: 'DeepSeek/OpenAI style key', pattern: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: 'personal Windows path', pattern: /C:\\Users\\(?!you\b|%|\\|\.\.\.)[A-Za-z0-9._-]+\\/i },
  { name: 'chat id literal', pattern: /\b[0-9a-f]{8,}@im\.(?:bot|wechat)\b/i },
  { name: 'inline bot token', pattern: /"bot_token"\s*:\s*"[A-Za-z0-9]/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'API key assignment', pattern: /\b(?:DEEPSEEK|OPENAI|ANTHROPIC)_API_KEY\s*[:=]\s*["'][A-Za-z0-9]/ },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.gitignore' && entry.name !== '.gitattributes') {
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let scanned = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (!TEXT_EXTENSIONS.has(extname(file)) && !rel.endsWith('.gitignore') && !rel.endsWith('.gitattributes')) continue;
  if (rel === 'scripts/check.mjs') continue; // this file contains the patterns themselves
  if (rel.startsWith('tests/')) continue; // fixtures use synthetic ids on purpose
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  for (const rule of SECRET_PATTERNS) {
    const match = rule.pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      fail('secret', `${rel}:${line} ${rule.name}`);
    }
  }
}
ok('secret', `${scanned} files scanned`);

// ------------------------------------------------------------------- summary

for (const note of notes) console.log(`  note ${note}`);
if (findings.length) {
  console.error(`\n${findings.length} problem(s):`);
  for (const item of findings) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('\nall checks passed');
