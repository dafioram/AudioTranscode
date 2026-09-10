/**
 * ffmpeg.wasm wrapper.
 *
 * Loads the single-threaded core once, then runs one file at a time through it.
 * The core is serial by nature, so a queue rather than parallel calls.
 *
 * IMPORTANT — @ffmpeg/ffmpeg must be self-hosted (vendor/), not loaded from a
 * CDN. This is not a preference, it's a hard requirement: the library spawns
 * its own background worker, and the ffmpeg.wasm maintainers say directly
 * that this cannot be done reliably across a CDN boundary —
 * https://github.com/ffmpegwasm/ffmpeg.wasm/discussions/798 — where a user
 * hit the exact symptom this app hit: "load never resolves". Convert and
 * Download appearing to do nothing, forever, with no error, is what that
 * looks like from the outside. js/config.js defaults to vendor/ for exactly
 * this reason; see the comment there and run `npm run vendor` before local
 * dev if you haven't.
 *
 * A second, related bug lived here previously: passing `classWorkerURL` to
 * `instance.load()` forces the UMD build to spawn its worker with
 * `{ type: "module" }`, but that worker (814.ffmpeg.js) is a classic script
 * that calls `importScripts()` — undefined inside a module worker. That
 * failure mode is now moot since we no longer construct classWorkerURL at
 * all — ffmpeg.js resolves its own worker chunk via `document.currentScript`,
 * which now points at our own vendor/ directory instead of a CDN — but the
 * `buildLoadConfig` test below still guards against it sneaking back in.
 *
 * A third bug: this file used to load `@ffmpeg/util` for its `toBlobURL`
 * helper. That package's published `dist/umd/index.js` is broken as a
 * browser script — its outer shell correctly detects "no CommonJS, no AMD,
 * plain browser" and falls through to a global, but the bundled code inside
 * that shell still contains bare, unguarded `exports`/`require` references
 * left over from its CommonJS compilation. In a real browser, neither
 * global exists, so the very first line throws
 * `Uncaught ReferenceError: exports is not defined` the moment the script
 * runs — before `loadEngine()` even gets a chance to catch anything.
 * `@ffmpeg/ffmpeg` and `@ffmpeg/core`'s own UMD bundles were checked and do
 * not have this defect; it's specific to `@ffmpeg/util`. Since the only
 * thing we used from it was a four-line wrapper around `fetch` + `Blob` +
 * `URL.createObjectURL`, `toBlobURL` below is that function, confirmed
 * against the actual published source rather than reimplemented from memory.
 * This removes the dependency — and the vendored `util.js` file — entirely.
 *
 * A fourth bug, this one in ffmpeg.wasm itself rather than anything
 * vendored: a single loaded `FFmpeg` instance is not safe to run a second
 * `exec()` against. This is long-standing and reported repeatedly upstream —
 * ffmpegwasm/ffmpeg.wasm#330 ("Can't reuse ffmpeg") and #436, the latter
 * specifically about the single-threaded build, which is what this app uses —
 * and matches what showed up here exactly: the first conversion in a session
 * works, the second throws a low-level WebAssembly trap
 * (`RuntimeError: index out of bounds`) with no useful message. The cause
 * lives in ffmpeg's own C code, not this wrapper: ffmpeg was built to run
 * once per process and exit, so its internal global/static state doesn't get
 * fully reset between repeated in-process invocations, and eventually a
 * second run reads or writes through a stale pointer. The workaround
 * confirmed on that issue thread — terminate the instance and load a fresh
 * one before the next command — is what this file now does for every single
 * conversion: `convertFile` creates a brand new `FFmpeg()`, loads it, uses it
 * once, and terminates it in every case (success, failure, or a thrown
 * error), whether or not the batch has more files after it. The expensive
 * part — fetching the ~32 MB core over the network — is still cached and
 * only ever done once; `prepareAssets` below is what's shared, not the
 * instance itself.
 */
import { ASSETS } from './config.js';
import { FORMATS, buildArgs, buildArgsWithoutArt } from './formats.js';

let assets = null;
let preparing = null;
const logLines = [];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(tag);
  });
}

/**
 * Fetch a URL and hand back a same-origin blob: URL for its contents. This is
 * what `@ffmpeg/util`'s `toBlobURL` does (minus the progress-reporting
 * variant we never call) — reimplemented here rather than depending on that
 * package; see the file comment above.
 */
export async function toBlobURL(url, mimeType) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const blob = new Blob([buffer], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * The exact object passed to `instance.load()`. Pulled out as its own
 * function so a test can assert `classWorkerURL` never sneaks back in
 * without needing a real browser or a real ffmpeg.wasm instance.
 */
export function buildLoadConfig({ coreURL, wasmURL }) {
  return { coreURL, wasmURL };
}

/**
 * Fetches ffmpeg.js (once) and blob-ifies the core JS/wasm (once). Deliberately
 * does not create or load an `FFmpeg` instance — see the file comment for why
 * that has to happen fresh per conversion instead of being cached here.
 * Safe to call repeatedly; the network work happens once.
 * @param {(stage: string, ratio: number) => void} [onProgress]
 */
export function prepareAssets(onProgress) {
  if (assets) return Promise.resolve(assets);
  if (preparing) return preparing;

  preparing = (async () => {
    const report = onProgress || (() => {});
    report('Fetching the encoder', 0);

    if (!self.FFmpegWASM) await loadScript(ASSETS.ffmpegJs);

    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(ASSETS.coreJs, 'text/javascript'),
      toBlobURL(ASSETS.coreWasm, 'application/wasm'),
    ]);

    report('Ready', 1);
    assets = { coreURL, wasmURL };
    return assets;
  })();

  preparing.catch(() => { preparing = null; });
  return preparing;
}

/** Kept as the public name the rest of the app calls; see prepareAssets. */
export function loadEngine(onProgress) {
  return prepareAssets(onProgress);
}

/** Whether the ~32 MB core has already been fetched, for the loading copy. */
export function engineReady() {
  return Boolean(assets);
}

/** Last few ffmpeg log lines, used to explain a failure. */
export function recentLog(count = 12) {
  return logLines.slice(-count).join('\n');
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return match ? match[1].toLowerCase() : 'bin';
}

/**
 * Convert one file, on a freshly loaded instance that is always terminated
 * before this function returns or throws — see the file comment for why.
 *
 * @param {object} job
 * @param {File} job.file
 * @param {string} job.formatId
 * @param {string} job.qualityId
 * @param {{mime: string, bytes: Uint8Array}|null} job.cover
 * @param {object} job.tags
 * @param {(ratio: number) => void} [job.onProgress]
 * @returns {Promise<{bytes: Uint8Array, mime: string, ext: string, droppedArt: boolean}>}
 */
export async function convertFile(job) {
  const { coreURL, wasmURL } = await prepareAssets();
  const { FFmpeg } = self.FFmpegWASM;

  const instance = new FFmpeg();
  instance.on('log', ({ message }) => {
    logLines.push(message);
    if (logLines.length > 400) logLines.shift();
  });

  const onProgress = job.onProgress || (() => {});
  const handleProgress = ({ progress }) => {
    if (typeof progress === 'number' && isFinite(progress)) {
      onProgress(Math.min(1, Math.max(0, progress)));
    }
  };
  instance.on('progress', handleProgress);

  try {
    await instance.load(buildLoadConfig({ coreURL, wasmURL }));

    const fmt = FORMATS[job.formatId];
    const stamp = Math.random().toString(36).slice(2, 8);
    const inputName = `in-${stamp}.${extensionOf(job.file.name)}`;
    const outputName = `out-${stamp}.${fmt.ext}`;
    const coverName = job.cover ? `art-${stamp}.${job.cover.mime === 'image/png' ? 'png' : 'jpg'}` : null;

    const buffer = new Uint8Array(await job.file.arrayBuffer());
    await instance.writeFile(inputName, buffer);

    if (coverName && fmt.coverArt) {
      await instance.writeFile(coverName, job.cover.bytes);
    }

    const args = {
      inputName,
      outputName,
      formatId: job.formatId,
      qualityId: job.qualityId,
      coverName: fmt.coverArt ? coverName : null,
      tags: job.tags || {},
    };

    let code = await instance.exec(buildArgs(args));
    let droppedArt = false;

    // Some sources carry artwork that the target container will not accept.
    // Losing the picture beats losing the track, so retry without it — this
    // is still safe on the same instance, since nothing has succeeded yet.
    if (code !== 0 && args.coverName) {
      droppedArt = true;
      code = await instance.exec(buildArgsWithoutArt(args));
    }
    if (code !== 0) {
      throw new Error(`The encoder rejected this file.\n${recentLog(8)}`);
    }

    const data = await instance.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!bytes.length) throw new Error('The encoder produced an empty file.');

    onProgress(1);
    return { bytes: bytes.slice(), mime: fmt.mime, ext: fmt.ext, droppedArt };
  } finally {
    // Terminating the whole instance also discards its virtual filesystem,
    // so there's no separate writeFile/deleteFile bookkeeping to do here —
    // and, more importantly, this is what actually avoids the corrupted
    // second-run state described above.
    try { instance.terminate(); } catch { /* already gone */ }
  }
}
