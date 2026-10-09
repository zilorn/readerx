import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, artifacts) {
  const root = mkdtempSync(join(tmpdir(), 'readerx-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src-tauri'));
  copyFileSync(new URL('./collect-artifacts.mjs', import.meta.url), join(root, 'scripts/collect-artifacts.mjs'));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.5.0', productName: 'readerx' }));
  for (const [flavor, variant, name] of artifacts) {
    const dir = join(root, 'src-tauri/gen/android/app/build/outputs/apk', flavor, variant);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), 'fixture APK bytes');
  }
  return (...args) => {
    const out = join(root, 'out');
    const result = spawnSync(process.execPath, [join(root, 'scripts/collect-artifacts.mjs'), 'android', ...args, '--out', out], { encoding: 'utf8' });
    return { ...result, files: result.status === 0 ? readdirSync(out) : [] };
  };
}

test('single ABI release collects only arm64 even when other outputs exist', t => {
  const run = fixture(t, [['arm64', 'release', 'app-arm64-release.apk'], ['x86', 'release', 'app-x86-release.apk']]);
  const result = run('--abi', 'arm64-v8a');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.files, ['readerx-0.5.0-android-arm64-v8a.apk']);
});

test('default release still requires all four ABIs', t => {
  const result = fixture(t, [['arm64', 'release', 'app-arm64-release.apk']])();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /armeabi-v7a/);
});

test('default release collects all four ABIs', t => {
  const run = fixture(t, ['arm64', 'arm', 'x86', 'x86_64'].map(f => [f, 'release', `app-${f}-release.apk`]));
  assert.equal(run().files.length, 4);
});

test('rejects unsigned APKs including unexpected unsigned names', t => {
  for (const name of ['app-arm64-release-unsigned.apk', 'other-unsigned.apk']) {
    const result = fixture(t, [['arm64', 'release', name]])('--abi', 'arm64-v8a');
    assert.notEqual(result.status, 0);
  }
});

test('missing requested ABI fails rather than collecting another ABI', t => {
  const result = fixture(t, [['x86', 'release', 'app-x86-release.apk']])('--abi', 'arm64-v8a');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /arm64-v8a/);
});

test('debug single ABI and existing universal debug preserve names', t => {
  const run = fixture(t, [['arm64', 'debug', 'app-arm64-debug.apk'], ['universal', 'debug', 'app-universal-debug.apk']]);
  assert.deepEqual(run('--debug', '--abi', 'arm64-v8a').files, ['readerx-0.5.0-android-arm64-v8a-debug.apk']);
  assert.equal(run('--debug').files.length, 2);
});

test('rejects unknown ABI and universal release', t => {
  const run = fixture(t, []);
  for (const abi of ['aarch64', 'unknown', 'universal']) assert.notEqual(run('--abi', abi).status, 0);
});
