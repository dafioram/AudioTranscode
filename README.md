# Transcode

A static audio converter that runs entirely in the browser. Drop in music, read
its tags, convert it to Opus, AAC, MP3, FLAC or WAV, and download the result.
No server, no upload, no account. The audio never leaves the machine it is
played on.

Built to be served as flat files, so GitHub Pages hosts it as-is.

---

## Quick start

```bash
git clone https://github.com/YOUR-USERNAME/transcode.git
cd transcode
npm install          # only needed for the test suite
npm start            # first run downloads the encoder (~32 MB, one time), then serves at http://localhost:8080
```

There is no build step for the site itself. `index.html`, `css/` and `js/` are
the whole thing; `vendor/` (the encoder, fetched on first run) sits alongside
them. See "Self-hosting the encoder" below for why this step exists and isn't
optional.

---

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow in `.github/workflows/deploy.yml` runs the
   tests, fetches the encoder into `vendor/` (see below — this step is
   required, not optional), and publishes the site.

That is the entire deployment. No headers to configure, no server-side runtime.

### Why it works on Pages without special headers

Multi-threaded ffmpeg.wasm needs `SharedArrayBuffer`, which browsers only grant
to pages that send `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
headers. GitHub Pages does not let you set custom headers, so that build is off
the table.

This app pins `@ffmpeg/core` **0.12.10**, the single-threaded build. It contains
no `SharedArrayBuffer` or `pthread` references at all, so it needs no headers.
Encoding is slower than the multi-threaded build, which matters for video and
barely matters for audio.

If you later want the faster build, move the site to a host that lets you set
headers (Cloudflare Pages, Netlify, Vercel) and switch to `@ffmpeg/core-mt`.

---

## How the threading works

Three things could block the interface, so none of them run on the main thread.

| Work | Where it runs |
| --- | --- |
| Reading tags, artwork and duration | `js/media-worker.js`, a Web Worker |
| Building the batch zip | the same Web Worker |
| Audio encoding | a worker that ffmpeg.wasm manages itself |

Encoding is deliberately **not** wrapped in our own worker. `@ffmpeg/ffmpeg`
0.12 already runs the codec in a worker it spawns internally, so wrapping it
would nest workers — unnecessary, and historically flaky in Safari. The main
thread only ever touches the DOM.

---

## Formats

### Playing a preview

Every row has a play button next to its title — plays the original file
immediately, no conversion needed. Once a file is converted, a second "Play
converted" control appears next to Download, so you can A/B the two before
committing to a download. Only one file plays at a time.

### Input

MP3, M4A, MP4, AAC, FLAC, WAV, OGG, Opus, AIFF, ALAC, WebM, MKA, APE.

Tags and artwork are read natively for MP3 (ID3v2.2/2.3/2.4), MP4/M4A, FLAC,
Ogg Vorbis, Ogg Opus and WAV. Other containers still convert; they just may
show fewer tags.

### Output

| Format | Best for | Artwork |
| --- | --- | --- |
| **AAC** (.m4a) | Default. Full quality, smaller than MP3, plays everywhere | Yes |
| **Opus** | Smallest file, but capped at reduced treble in this app — see below | No |
| **MP3** | Maximum compatibility | Yes |
| **FLAC** | Lossless archiving | Yes |
| **WAV** | Editing and mastering | No |

Text tags carry across all five. Artwork is embedded where the container
supports it. Opus stores pictures in a way ffmpeg will not write, so artwork is
dropped for Opus output and the app says so on the row.

**About Opus specifically:** the exact wasm build this app runs on cannot
encode Opus at 48 kHz ("fullband," full audible range) at all — every attempt
throws a WebAssembly crash, confirmed directly against the real
`ffmpeg-core.wasm` binary (see Troubleshooting). The fix is to encode at
24 kHz instead, which avoids the crash but caps audible bandwidth at roughly
12 kHz *regardless of bitrate* — cymbals, upper harmonics, and general "air"
above that are cut, on every quality tier. That's a real trade-off, not a
technicality, which is why AAC — unaffected by this limitation — is the
default here rather than Opus, even though Opus can still produce a smaller
file for anyone who wants that and is fine with the ceiling.

### Converting a 320 kbps MP3 library

MP3 is already lossy. Anything you convert it to is a re-encode of data that has
already been thrown away, so the goal is "no *further* audible loss", not
recovering quality that is gone.

- **AAC at 192k** (the default here) — full range, noticeably smaller than a
  320k MP3, and it plays on essentially everything: iOS, car stereos, Android,
  Windows.
- **Opus at 160k** — smaller still, but see the treble cap above. Fine for
  spoken word, podcasts, or casual listening; more likely to be noticeable on
  music with cymbals or strings, especially on good headphones.
- **Avoid FLAC** — lossless, but lossless-encoding a lossy source just makes a
  bigger file with no quality gain. The app flags this: the size bar turns amber
  and says the file grows.

---

## Self-hosting the encoder

This is not an optional advanced step — it's how the app works at all.

`@ffmpeg/ffmpeg` spawns its own background worker, and the people who maintain
ffmpeg.wasm are explicit that this **cannot be done reliably from a CDN**:
[github.com/ffmpegwasm/ffmpeg.wasm/discussions/798](https://github.com/ffmpegwasm/ffmpeg.wasm/discussions/798).
Loading it from unpkg or any other CDN via a `<script>` tag leads to `load()`
simply never resolving — no error, no timeout, just silence. From the app's
side, that looks exactly like Convert and Download doing nothing at all.

So this app fetches the encoder into `vendor/` and serves it from its own
origin:

```bash
npm run vendor
```

This downloads the pinned files (via the npm registry, not a CDN) into
`vendor/`. `npm start` runs this automatically first (skipping it if `vendor/`
is already complete), and the GitHub Actions workflow runs it before every
deploy. `vendor/` is gitignored — it's fetched fresh each time rather than
committed, since it's ~32 MB of binary that never changes between commits.

If you ever see the app hang forever on "Loading the encoder…" with no error,
the first thing to check is whether `vendor/` actually has all four files
(`ffmpeg.js`, `814.ffmpeg.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`) and
whether they're actually reachable at `/vendor/...` from wherever you're
serving the site. Note there's no `util.js` in that list on purpose — see
the next section.

---

## Troubleshooting

**Convert and Download do nothing, forever, with no error — even though the
file's tags showed up fine.** This has one likely cause and one historical
one, both already fixed here but worth knowing about if this app gets
modified later.

The real cause: **`@ffmpeg/ffmpeg` was being loaded from a CDN.** Its own
maintainers say this can't be done reliably, because the library spawns its
own worker and that worker's cross-origin loading is inconsistent across
browsers — see
[discussion #798](https://github.com/ffmpegwasm/ffmpeg.wasm/discussions/798),
where another developer hit the identical symptom: "`load` never resolves."
Tags still work in this state because reading them runs entirely in
`media-worker.js`, a plain Web Worker that has nothing to do with ffmpeg — so
metadata working is not evidence the encoder is fine. The fix is what the
"Self-hosting the encoder" section above describes: serve `@ffmpeg/ffmpeg`
from the page's own origin via `vendor/`, which removes the cross-origin
worker rather than working around it. `js/config.js` defaults to this; don't
switch it back to the CDN config.

A second, narrower bug lived in the same area: passing `classWorkerURL` to
`instance.load()` forces the UMD build to spawn its worker with
`{ type: "module" }`, but the worker script (`814.ffmpeg.js`) is a classic
bundle that calls `importScripts()` — undefined inside a module worker. This
is now moot (we no longer construct `classWorkerURL` at all), but
`test/converter.test.mjs` still asserts it can't sneak back in.

**Browser console shows `Uncaught ReferenceError: exports is not defined` at
`vendor/util.js`.** This one is a genuine bug in the published
`@ffmpeg/util` package itself, not in this app's code or in `@ffmpeg/ffmpeg`
or `@ffmpeg/core` (both of those were checked directly and are fine). Its
`dist/umd/index.js` has a UMD wrapper that correctly detects "plain browser,
no CommonJS, no AMD" — but the bundled code *inside* that wrapper still
contains bare, unguarded `exports`/`require` references left over from its
CommonJS build, which don't exist as globals in a browser and throw the
instant the script runs. The only thing this app used from that package was
a four-line wrapper around `fetch` + `Blob` + `URL.createObjectURL`
(`toBlobURL`), confirmed against the package's actual source rather than
guessed, and reimplemented directly in `js/converter.js`. `@ffmpeg/util` is
no longer a dependency at all — it isn't vendored, and nothing loads it.

If you self-host correctly and it *still* hangs, open the browser console —
a genuine network or CORS failure at that point will show there, which is the
one signal this specific failure mode doesn't otherwise give you.

**Convert worked once, then clicking it again did nothing.** This was a real
UI bug: the button's enabled/label state was computed from "not currently
reading tags," but the actual conversion queue was "not reading *and not
already done*." Once your one file finished, it still counted toward the
button's total, so it stayed enabled and labelled "Convert 1 file" — but the
real queue behind it was empty, so clicking it hit nothing and did, quite
literally, nothing. Both places now share one `pendingItems()` function, so
they can't drift apart again; the button now reads "All converted" and
disables itself once there's nothing left to do, and re-enables with the
correct count as soon as you add another file.

**First conversion works, the next one throws `RuntimeError: index out of
bounds` (or the browser just hangs).** This is a long-standing bug in
ffmpeg.wasm itself, not this app —
[ffmpegwasm/ffmpeg.wasm#330](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/330)
and
[#436](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/436) (the latter
specifically about the single-threaded build used here) both report exactly
this: a loaded `FFmpeg` instance is not safe to run a second `exec()`
against. The cause is in ffmpeg's own C code — it was built to run once per
process and exit, so its internal global/static state doesn't fully reset
between repeated in-process runs, and a second run eventually reads or
writes through a stale pointer. The confirmed workaround from that issue
thread is to terminate the instance and load a fresh one for every command,
which is what `js/converter.js` now does: every `convertFile()` call gets
its own `FFmpeg()` instance, used once and terminated in every case —
success, failure, or a thrown error — whether or not more files are queued
behind it. The expensive part, fetching the ~32 MB core, is still cached and
only ever happens once; only the lightweight instance itself is recreated
per file. `test/converter.test.mjs` locks this in with a fake `FFmpeg` class
that would fail the test if a future change went back to one shared,
cached instance.

**Opus conversion specifically throws `RuntimeError: memory access out of
bounds`, while other formats work fine.** This is a real, permanent
limitation of the exact `@ffmpeg/core` 0.12.10 single-threaded build this app
uses (0.12.10 is also the latest version published, so there's no newer
release to upgrade to): it cannot encode Opus at 48 kHz — "fullband," the
mode covering the full range of human hearing — at all. Every attempt
crashes, with or without `-vbr`, `-application`, metadata mapping, or
anything else, and it doesn't matter whether the source is already 48 kHz
(so it isn't specifically a resampling problem). This was confirmed directly,
not just from reading about it: by loading the actual `ffmpeg-core.wasm`
binary in Node and driving it with a fresh instance per test (the same
approach as the bug above, and for the same reason — a shared instance would
contaminate the results), every 48 kHz attempt crashed and every 24 kHz and
16 kHz attempt succeeded, on the exact same source file. It's also reported
upstream: [ffmpegwasm/ffmpeg.wasm#591](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/591)
and [#867](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/867).

The fix in `js/formats.js` is `-ar 24000` — the highest confirmed-working
rate — verified by running the *actual* `buildArgs()` output for every Opus
quality tier against the real core binary (`96k` through `192k` all
succeeded with sensible output sizes). But this is a real trade-off, not a
technicality: 24 kHz caps audible bandwidth at roughly 12 kHz no matter the
bitrate, which is why this app's default format changed from Opus to AAC —
AAC has no such ceiling here — rather than quietly shipping degraded audio
under an unchanged "best quality" recommendation. Opus is still available
for anyone who wants the smaller file and is fine with the cap; the copy in
the app and in this README says so rather than repeating the old "sounds
like 320k MP3" claim, which was only ever true for 48 kHz Opus.
`test/metadata.test.mjs` asserts every Opus quality tier's built command
includes `-ar 24000` and never `48000`.

**CI failed on "non-ASCII filenames round-trip through the UTF-8 flag" with a
garbled filename in the error, like `L├еt тДЦ 3 тАФ цЭ▒ф║м.opus` instead of
`Låt № 3 — 東京.opus`.** This is a genuine bug in Info-ZIP UnZip 6.00
(2009) — still what Debian and Ubuntu ship. When `LANG` is exactly
`C.UTF-8`, which GitHub Actions' hosted runners set by default, that specific
build ignores the UTF-8 flag on a zip entry and decodes the name as CP866
instead. Every other locale value — `C`, `POSIX`, unset, `en_US.UTF-8` —
decodes it correctly; it's specifically the string `C.UTF-8` that trips the
bug. Confirmed by reproducing it locally (`LANG=C.UTF-8 npm test`) and by a
negative control: reverting the fix reproduces the exact failure under that
locale, restoring it passes. `test/zipwriter.test.mjs` now pins
`LANG=C`/`LC_ALL=C` for its own `unzip` subprocess calls rather than
inheriting whatever the calling shell happens to have set.

## Tests

```bash
npm test
```

81 tests covering the parts that are easy to get quietly wrong:

- **Tag parsing** against real files written by the ffmpeg CLI, not hand-made
  byte blobs. Covers ID3v2.2/2.3/2.4 including UTF-16 text, MP4 atoms, FLAC
  metadata blocks, Ogg pages and RIFF chunks, plus artwork extraction verified
  down to JPEG and PNG magic bytes.
- **Duration** from Xing VBR headers, FLAC STREAMINFO, MP4 `mvhd`, Ogg granule
  positions and WAV byte rates.
- **The ffmpeg commands each format builds**, including that every Opus
  quality tier requests the crash-safe 24 kHz and never 48 kHz — see
  Troubleshooting for why that matters.
- **The zip writer**, round-tripped through the system `unzip` binary, so a pass
  means a standard archiver accepts the output. Includes CRC checks, non-ASCII
  filenames, duplicate names and path-traversal sanitising.
- **The interface**, driven in jsdom against the real `index.html` and `app.js`,
  with only ffmpeg.wasm stubbed. Covers intake, tag display and editing, size
  estimates, conversion, per-file failure handling, audio preview playback
  (original and converted, one at a time), and the zip download.
- **The encoder loading path** (`test/converter.test.mjs`): pins down the
  exact object passed to `instance.load()` so the `classWorkerURL` mistake
  can't quietly return; runs the real `toBlobURL` replacement against a real
  fetch/Blob/object-URL round trip so its replacement for `@ffmpeg/util`
  stays correct; and, using a fake `FFmpeg` class, confirms every conversion
  gets its own instance and every instance is terminated exactly once — the
  mechanism behind the ffmpeg.wasm reuse bug described in Troubleshooting.

Fixtures are generated, not committed. `npm test` builds them first via
`test/make-fixtures.sh`, which needs `ffmpeg` on your PATH. Without ffmpeg the
file-based tests skip rather than fail.

Waits in the interface test poll for the actual condition (a row reaching
`done`, a URL count increasing) rather than sleeping a fixed number of
milliseconds — a slower machine just polls a few more times instead of the
test flaking.

### What is not covered

ffmpeg.wasm is stubbed inside the automated test suite itself — `npm test`
doesn't spend 32 MB and real wasm execution on every run. But "not in the
automated suite" isn't the same as "never actually run": every codec path
this app uses (Opus at every quality tier, AAC, MP3, FLAC) has been driven
directly against the real `ffmpeg-core.wasm` binary by loading it in Node
with a fresh instance per test — the same binary that ships in `vendor/` —
and checked for a real success exit code and a real, correctly-sized output
file, not just an absence of exceptions. That's how both the instance-reuse
bug and the Opus 48 kHz crash in Troubleshooting were actually found and
confirmed fixed, rather than guessed at. What that verification can't stand
in for is the browser itself: real Worker cross-origin behavior, real COOP/
COEP-free page loading, and the full click-Convert-see-a-file round trip in
an actual tab are the one thing that still needs a real browser to confirm.

---

## Browser support

Needs ES modules in Web Workers: Chrome 80+, Edge 80+, Safari 15+, Firefox 114+.

---

## Licence

MIT. See `LICENSE`.

ffmpeg.wasm is separately licensed; the core build here is LGPL/GPL depending on
the codecs compiled in. See the [ffmpeg.wasm repository](https://github.com/ffmpegwasm/ffmpeg.wasm).
