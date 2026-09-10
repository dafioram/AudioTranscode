/**
 * Where the ffmpeg.wasm assets come from.
 *
 * Vendored (self-hosted) is the default and the only supported path. Run
 * `npm run vendor` once before local dev or deployment — the GitHub Actions
 * workflow runs it automatically, so you generally don't need to think about
 * this except for local `npm start`.
 *
 * The `remote` (CDN) config below is kept only for reference. Do not switch
 * to it: the ffmpeg.wasm maintainers are explicit that @ffmpeg/ffmpeg cannot
 * be loaded from a CDN via a <script> tag, because it spawns its own worker
 * and that worker's cross-origin loading is unreliable —
 * https://github.com/ffmpegwasm/ffmpeg.wasm/discussions/798 — which is
 * exactly the "Convert does nothing, forever" failure this app hit before
 * vendoring became the default. Self-hosting puts every file on the page's
 * own origin, which removes the cross-origin worker entirely rather than
 * working around it. See the note at the top of js/converter.js.
 *
 * Versions are pinned. @ffmpeg/core 0.12.10 is the single-threaded build: it
 * contains no SharedArrayBuffer or pthread references, which is why this works
 * on GitHub Pages without COOP/COEP headers.
 *
 * There is no @ffmpeg/util here on purpose. Its published UMD bundle throws
 * `ReferenceError: exports is not defined` the instant it runs in a real
 * browser — a genuine bug in that package, not something fixable from this
 * side. The one function we needed from it (`toBlobURL`) is reimplemented
 * directly in js/converter.js instead. See the comment there.
 */

export const USE_VENDORED = true;

const CDN = 'https://unpkg.com';

export const FFMPEG_VERSION = '0.12.15';
export const CORE_VERSION = '0.12.10';

const remote = {
  ffmpegJs: `${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/ffmpeg.js`,
  ffmpegWorkerJs: `${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/814.ffmpeg.js`,
  coreJs: `${CDN}/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.js`,
  coreWasm: `${CDN}/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.wasm`,
};

const vendored = {
  ffmpegJs: './vendor/ffmpeg.js',
  ffmpegWorkerJs: './vendor/814.ffmpeg.js',
  coreJs: './vendor/ffmpeg-core.js',
  coreWasm: './vendor/ffmpeg-core.wasm',
};

export const ASSETS = USE_VENDORED ? vendored : remote;

/** Roughly what the browser downloads on first use, for the loading copy. */
export const ENGINE_DOWNLOAD_MB = 32;
