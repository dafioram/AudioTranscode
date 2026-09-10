/**
 * Regression tests for two real bugs found in production, both in how the
 * encoder gets loaded into the page.
 *
 * 1. Passing `classWorkerURL` to `instance.load()` forces the ffmpeg.wasm UMD
 *    build to spawn its background worker with `{ type: "module" }`. The
 *    actual worker script it spawns (814.ffmpeg.js) is a classic UMD bundle
 *    that calls `importScripts()` — undefined inside a module worker — so
 *    the load call fails on every attempt, and a same-session retry reuses
 *    the same broken, cached worker instead of creating a fresh classic one.
 *    Symptom: Convert and Download did nothing at all, no error.
 *
 * 2. `@ffmpeg/util`'s published `dist/umd/index.js` throws
 *    `ReferenceError: exports is not defined` immediately on load in a real
 *    browser — its outer UMD shell is fine, but the bundled code inside it
 *    still has bare, unguarded `exports`/`require` references left over from
 *    its CommonJS build. Symptom: identical to #1 from the outside, since
 *    the script error happens before any of this app's own error handling
 *    gets a chance to run.
 *
 * There is no real ffmpeg.wasm or browser here, so neither failure can be
 * reproduced directly. What these tests do instead: pin down the exact
 * object handed to `instance.load()` so #1 can't quietly reappear, and run
 * the real `toBlobURL` replacement against a real fetch/Blob so a regression
 * in — or an accidental reintroduction of — the code it replaces would
 * actually be caught.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoadConfig, toBlobURL, convertFile } from '../js/converter.js';

test('the load config sent to ffmpeg.wasm never includes classWorkerURL', () => {
  const config = buildLoadConfig({
    coreURL: 'blob:https://example.test/core',
    wasmURL: 'blob:https://example.test/wasm',
  });
  assert.deepEqual(Object.keys(config).sort(), ['coreURL', 'wasmURL']);
  assert.equal('classWorkerURL' in config, false);
});

test('buildLoadConfig ignores any extra keys a caller might pass', () => {
  const config = buildLoadConfig({
    coreURL: 'a', wasmURL: 'b', classWorkerURL: 'c', workerURL: 'd',
  });
  assert.deepEqual(config, { coreURL: 'a', wasmURL: 'b' });
});

// ------------------------------------------------------------------------
// toBlobURL replaces @ffmpeg/util's version, which throws
// `ReferenceError: exports is not defined` the instant it runs in a real
// browser (a genuine bug in that package's published UMD build — see the
// comment atop js/converter.js). These tests run the real function against
// a real fetch and a real Blob, not a mock, so a regression that reintroduces
// a dependency on @ffmpeg/util or silently changes toBlobURL's behavior would
// actually be caught here.

test('toBlobURL produces a blob: URL that reads back the original bytes', async () => {
  const original = 'hello from toBlobURL';
  const dataUrl = `data:text/plain;base64,${Buffer.from(original).toString('base64')}`;

  const blobUrl = await toBlobURL(dataUrl, 'text/plain');
  assert.match(blobUrl, /^blob:/);

  const readBack = await fetch(blobUrl).then((r) => r.text());
  assert.equal(readBack, original);
});

test('toBlobURL sets the MIME type it was given, independent of the source', () => {
  return (async () => {
    const dataUrl = 'data:text/plain;base64,AAA=';
    const blobUrl = await toBlobURL(dataUrl, 'application/wasm');
    const response = await fetch(blobUrl);
    assert.equal(response.headers.get('content-type'), 'application/wasm');
  })();
});

test('toBlobURL preserves exact byte content for binary data, not just text', async () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 127, 128]);
  const dataUrl = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;

  const blobUrl = await toBlobURL(dataUrl, 'application/octet-stream');
  const readBack = new Uint8Array(await fetch(blobUrl).then((r) => r.arrayBuffer()));
  assert.deepEqual(readBack, bytes);
});

// ------------------------------------------------------------------------
// A fourth bug, this one in ffmpeg.wasm itself: a single loaded instance is
// not safe to exec() a second time (ffmpegwasm/ffmpeg.wasm#330, #436) — the
// first conversion in a session works, the second throws a low-level
// `RuntimeError: index out of bounds` with no useful message. The fix is a
// fresh instance, loaded and terminated, per conversion.
//
// There's no real ffmpeg.wasm here to reproduce the actual WebAssembly trap,
// but this test uses a minimal fake `FFmpeg` class (standing in for
// `self.FFmpegWASM.FFmpeg`) to confirm the *mechanism* the fix depends on:
// every `convertFile()` call gets its own instance, every instance is
// terminated exactly once regardless of outcome, and the network fetch for
// the core itself still only happens once across multiple conversions. A
// regression back to one shared, cached instance — which is exactly what
// caused the bug — would show up here as instance ids colliding or a
// terminate count that doesn't match the number of conversions.

test('convertFile uses a fresh, independent instance for every conversion', async () => {
  const created = [];
  let nextId = 1;
  let fetchCalls = 0;

  class FakeFFmpeg {
    constructor() {
      this.id = nextId++;
      this.files = new Map();
      this.listeners = {};
      this.terminated = 0;
      created.push(this);
    }
    on(event, fn) { (this.listeners[event] ||= []).push(fn); }
    off(event, fn) {
      this.listeners[event] = (this.listeners[event] || []).filter((f) => f !== fn);
    }
    async load() { /* fake: nothing to actually load */ }
    async writeFile(name, bytes) { this.files.set(name, bytes); }
    async readFile(name) {
      if (!this.files.has(name)) throw new Error(`fake ffmpeg: no such file ${name}`);
      return this.files.get(name);
    }
    async exec(args) {
      // buildArgs always puts the output filename last; tag the "encoded"
      // bytes with this instance's id so the test can tell which instance
      // actually produced which result.
      const outputName = args[args.length - 1];
      this.files.set(outputName, new Uint8Array([this.id, 9, 9, 9]));
      return 0;
    }
    terminate() { this.terminated += 1; }
  }

  const originalFetch = globalThis.fetch;
  const originalSelf = globalThis.self;
  globalThis.self = { FFmpegWASM: { FFmpeg: FakeFFmpeg } };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(new Uint8Array([1, 2, 3]));
  };

  try {
    const file = new File(['fake audio bytes'], 'song.mp3', { type: 'audio/mpeg' });
    const job = { file, formatId: 'opus', qualityId: '160', cover: null, tags: {} };

    const first = await convertFile(job);
    const second = await convertFile(job);

    assert.equal(created.length, 2, 'each conversion should create its own instance');
    assert.notEqual(created[0].id, created[1].id, 'the two instances must be distinct objects');

    assert.equal(created[0].terminated, 1, 'the first instance must be terminated exactly once');
    assert.equal(created[1].terminated, 1, 'the second instance must be terminated exactly once');

    // Each result is tagged with the id of the instance that produced it,
    // proving the second conversion ran on its own instance rather than
    // reusing (and inheriting corrupted state from) the first.
    assert.equal(first.bytes[0], created[0].id);
    assert.equal(second.bytes[0], created[1].id);

    // The expensive part — fetching the core — is still shared: two
    // conversions should not mean two 32 MB downloads.
    assert.equal(fetchCalls, 2, 'coreJs and coreWasm fetched once each, not once per conversion');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});

test('convertFile terminates its instance even when the encoder rejects the file', async () => {
  const created = [];

  class FailingFakeFFmpeg {
    constructor() { this.terminated = 0; created.push(this); }
    on() {}
    off() {}
    async load() {}
    async writeFile() {}
    async readFile() { return new Uint8Array(); }
    async exec() { return 1; } // non-zero: the encoder "rejected" the input
    terminate() { this.terminated += 1; }
  }

  const originalFetch = globalThis.fetch;
  const originalSelf = globalThis.self;
  globalThis.self = { FFmpegWASM: { FFmpeg: FailingFakeFFmpeg } };
  globalThis.fetch = async () => new Response(new Uint8Array([1]));

  try {
    const file = new File(['x'], 'bad.mp3', { type: 'audio/mpeg' });
    const job = { file, formatId: 'mp3', qualityId: 'v2', cover: null, tags: {} };

    await assert.rejects(() => convertFile(job));
    assert.equal(created[0].terminated, 1, 'a failed conversion must still terminate its instance');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});
