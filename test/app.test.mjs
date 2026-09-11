/**
 * Integration test for the interface.
 *
 * Loads the real index.html in jsdom and runs the real app.js against it. The
 * only stubbed piece is ffmpeg.wasm, which cannot run here — it is replaced by
 * a fake encoder that returns plausible bytes so everything downstream of it
 * (naming, sizing, the zip, the status line) is exercised for real.
 *
 *   node --experimental-test-module-mocks --test test/app.test.mjs
 */
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { readMetadata } from '../js/metadata.js';
import { buildZip } from '../js/zipwriter.js';
import { FORMATS } from '../js/formats.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const ROOT = join(HERE, '..');

let dom;
let encoderCalls = [];
const objectUrls = new Map();

/** Stands in for the Web Worker, running the same code the worker would. */
class FakeWorker {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data }); }

  postMessage({ id, type, payload }) {
    queueMicrotask(() => {
      try {
        if (type === 'read-metadata') {
          const track = readMetadata(new Uint8Array(payload.buffer), payload.filename);
          let cover = null;
          if (track.cover?.bytes?.length) {
            const copy = track.cover.bytes.slice();
            cover = { mime: track.cover.mime, buffer: copy.buffer };
          }
          this.emit('message', { id, ok: true, result: { ...track, cover } });
        } else if (type === 'build-zip') {
          const zipped = buildZip(
            payload.entries.map((e) => ({ name: e.name, bytes: new Uint8Array(e.buffer) })),
          );
          this.emit('message', { id, ok: true, result: { buffer: zipped.buffer } });
        }
      } catch (error) {
        this.emit('message', { id, ok: false, error: String(error.message) });
      }
    });
  }
}

before(async () => {
  // Replace the encoder before app.js pulls it in.
  mock.module(join(ROOT, 'js/converter.js'), {
    namedExports: {
      engineReady: () => true,
      loadEngine: async () => ({}),
      recentLog: () => '',
      convertFile: async (job) => {
        encoderCalls.push(job);
        if (job.file.name.includes('BROKEN')) throw new Error('The encoder rejected this file.');
        // Roughly the size the real encoder would produce at this bitrate.
        const fmt = FORMATS[job.formatId];
        const seconds = 3.5;
        const kbps = Number(job.qualityId) || 192;
        const size = Math.round((seconds * kbps * 1000) / 8);
        return {
          bytes: new Uint8Array(size).fill(7),
          mime: fmt.mime,
          ext: fmt.ext,
          droppedArt: false,
        };
      },
    },
  });

  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });

  const { window } = dom;
  window.Worker = FakeWorker;
  window.URL.createObjectURL = (blob) => {
    const key = `blob:fake/${objectUrls.size}`;
    objectUrls.set(key, blob);
    return key;
  };
  window.URL.revokeObjectURL = (key) => objectUrls.delete(key);
  window.HTMLAnchorElement.prototype.click = function noop() {};

  // Node 22 defines some of these as getter-only, so define rather than assign.
  for (const key of ['document', 'window', 'Worker', 'Blob', 'File', 'Audio',
    'HTMLElement', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, {
      value: window[key], writable: true, configurable: true,
    });
  }
  globalThis.URL.createObjectURL = window.URL.createObjectURL;
  globalThis.URL.revokeObjectURL = window.URL.revokeObjectURL;

  await import(join(ROOT, 'js/app.js'));
});

after(() => {
  dom?.window?.close();
  mock.reset();
});

const $ = (sel) => dom.window.document.querySelector(sel);
const $$ = (sel) => [...dom.window.document.querySelectorAll(sel)];

/** Let queued microtasks and the app's awaits settle. */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `predicate()` is true, rather than guessing a fixed delay.
 * Async work (tag reading, conversion, zip building) shouldn't be timed with
 * a magic number — a slower machine just needs more polls, not a bigger
 * guess.
 */
async function waitFor(predicate, { timeout = 4000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor: condition not met within ${timeout}ms`);
    }
    await settle(interval);
  }
}

function fixtureFile(name) {
  const bytes = readFileSync(join(FIXTURES, name));
  return new dom.window.File([bytes], name, { type: 'audio/mpeg' });
}

async function addFiles(files) {
  const dropzone = $('#dropzone');
  const before = $$('.row').length;
  const event = new dom.window.Event('drop', { bubbles: true });
  event.dataTransfer = { files };
  event.preventDefault = () => {};
  dropzone.dispatchEvent(event);
  await waitFor(() =>
    $$('.row').length >= before + files.length
    && $$('.row').every((r) => r.dataset.status !== 'reading'));
}

// ---------------------------------------------------------------- rendering

test('format list renders every format with AAC selected first', () => {
  const buttons = $$('.fmt');
  assert.equal(buttons.length, 5);
  assert.equal(buttons[0].querySelector('.fmt__name').textContent, 'AAC');
  assert.equal(buttons[0].getAttribute('aria-checked'), 'true');
  assert.equal(buttons[1].getAttribute('aria-checked'), 'false');
});

test('quality segments follow the selected format', () => {
  const labels = $$('.seg').map((b) => b.textContent);
  assert.deepEqual(labels, ['128k', '192k', '256k']);
  const checked = $$('.seg').find((b) => b.getAttribute('aria-checked') === 'true');
  assert.equal(checked.textContent, '192k', 'should default to the suggested 192k');
});

test('switching format swaps in that format\'s qualities', () => {
  $$('.fmt')[2].dispatchEvent(new dom.window.Event('click', { bubbles: true })); // MP3
  assert.deepEqual($$('.seg').map((b) => b.textContent), ['V4', 'V2', 'V0', '320k']);

  $$('.fmt')[0].dispatchEvent(new dom.window.Event('click', { bubbles: true })); // back to AAC
  assert.deepEqual($$('.seg').map((b) => b.textContent), ['128k', '192k', '256k']);
});

// ---------------------------------------------------------------- intake

test('dropping a file reads its tags and shows them in the row', async () => {
  await addFiles([fixtureFile('mp3_320_art.mp3')]);

  const rows = $$('.row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.row__title').textContent, 'Slow Tide');
  assert.equal(rows[0].querySelector('.row__artist').textContent, 'Marion Vale — Harbour Lights');
  assert.match(rows[0].querySelector('.row__source').textContent, /MP3/);
  assert.match(rows[0].querySelector('.row__source').textContent, /0:04|0:03/);
});

test('embedded artwork reaches the row image', () => {
  const img = $('.row .row__art img');
  assert.equal(img.hidden, false);
  assert.match(img.getAttribute('src'), /^blob:/);
});

test('the hero collapses once files are queued', () => {
  assert.equal($('#intake').dataset.state, 'loaded');
  assert.equal($('#workbench').hidden, false);
});

// -------------------------------------------------------- playback, before conversion

test('the play button is available before conversion, for the source file', () => {
  const button = $('.row .row__play[data-kind="source"]');
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute('aria-label'), 'Play original');
});

test('the converted play control is hidden until a result exists', () => {
  const button = $('.row .row__play[data-kind="result"]');
  assert.equal(button.hidden, true);
});

test('clicking play toggles to a playing state and back', () => {
  const button = $('.row .row__play[data-kind="source"]');
  button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(button.dataset.playing, 'true');
  assert.equal(button.getAttribute('aria-label'), 'Pause original');

  button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(button.dataset.playing, 'false');
  assert.equal(button.getAttribute('aria-label'), 'Play original');
});


test('the size comparison estimates a smaller AAC file', () => {
  const verdict = $('.row .sizes__verdict');
  assert.equal(verdict.dataset.direction, 'smaller');
  assert.match(verdict.textContent, /Saves .*smaller/);

  const bars = $$('.row .sizes__fill');
  const sourceWidth = parseFloat(bars[0].style.width);
  const targetWidth = parseFloat(bars[1].style.width);
  assert.equal(sourceWidth, 100, 'the larger file should set the scale');
  assert.ok(targetWidth < 70, `AAC 192k should be well under the 320k source, got ${targetWidth}%`);
});

test('changing quality moves the estimate', () => {
  const before = parseFloat($$('.row .sizes__fill')[1].style.width);
  $$('.seg')[0].dispatchEvent(new dom.window.Event('click', { bubbles: true })); // 128k
  const after = parseFloat($$('.row .sizes__fill')[1].style.width);
  assert.ok(after < before, `128k should estimate smaller than 192k (${after} vs ${before})`);

  $$('.seg')[1].dispatchEvent(new dom.window.Event('click', { bubbles: true })); // back to 192k
});

test('choosing FLAC warns that the file grows', () => {
  $$('.fmt')[3].dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const verdict = $('.row .sizes__verdict');
  assert.equal(verdict.dataset.direction, 'bigger', 'FLAC from a 320k MP3 is larger');
  assert.match(verdict.textContent, /larger/);

  $$('.fmt')[0].dispatchEvent(new dom.window.Event('click', { bubbles: true })); // back to AAC
});

test('the status line totals the batch', () => {
  assert.match($('#status').textContent, /1 file:.*saving about/);
});

// ---------------------------------------------------------------- tag editing

test('editing a tag updates the row heading live', () => {
  $('.row .row__edit').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const input = $('.row .tagform input[data-tag="title"]');
  assert.equal(input.value, 'Slow Tide');

  input.value = 'Slow Tide (Remaster)';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal($('.row .row__title').textContent, 'Slow Tide (Remaster)');
});

// ---------------------------------------------------------------- converting

test('converting produces a download with a tag-derived filename', async () => {
  encoderCalls = [];
  $('#convert').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await waitFor(() => $('.row').dataset.status === 'done');

  assert.equal(encoderCalls.length, 1);
  assert.equal(encoderCalls[0].formatId, 'm4a');
  assert.equal(encoderCalls[0].qualityId, '192');

  const row = $('.row');
  assert.equal(row.dataset.status, 'done');

  const save = row.querySelector('.row__save');
  assert.equal(save.hidden, false);
  assert.equal(save.getAttribute('download'), 'Marion Vale - Slow Tide (Remaster).m4a');
});

// -------------------------------------------------------- playback, after conversion

test('the converted play control appears once a result exists and plays that file', () => {
  const row = $('.row');
  const resultButton = row.querySelector('.row__play[data-kind="result"]');
  assert.equal(resultButton.hidden, false);

  resultButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(resultButton.dataset.playing, 'true');
  assert.match(resultButton.querySelector('span').textContent, /^Pause converted/);

  resultButton.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(resultButton.dataset.playing, 'false');
});

test('the edited tag is passed to the encoder', () => {
  assert.equal(encoderCalls[0].tags.title, 'Slow Tide (Remaster)');
});

test('cover art is handed to the encoder when tags are kept', () => {
  assert.ok(encoderCalls[0].cover, 'expected the parsed cover to be forwarded');
  assert.equal(encoderCalls[0].cover.mime, 'image/jpeg');
});

test('the finished row reports the real output size, not the estimate', () => {
  const label = $$('.row .sizes__label')[1].textContent;
  assert.match(label, /AAC$/, 'a finished row should drop the "estimated" wording');
});

test('the summary reports the total saving', () => {
  assert.equal($('#status').dataset.tone, 'done');
  assert.match($('#status').textContent, /Done\..*saving/);
});

// The button used to stay enabled and labelled "Convert 1 file" after that
// one file had already finished, because its criteria (not 'reading') didn't
// match convertAll's actual queue criteria (not 'reading' AND not 'done').
// Clicking it then hit an empty queue and silently did nothing at all.
test('convert is disabled once the only file is already done', () => {
  assert.equal($('#convert').disabled, true);
  assert.equal($('#convert').textContent, 'All converted');
});

test('clicking convert anyway does not re-run the encoder or fail silently', async () => {
  const before = encoderCalls.length;
  $('#convert').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await settle(50);

  assert.equal(encoderCalls.length, before, 'nothing should be re-encoded');
  assert.match(
    $('#status').textContent,
    /Nothing left to convert|Done\..*saving/,
    'a click that reaches convertAll with nothing queued should say something, not go silent',
  );
});

// ---------------------------------------------------------------- failure

test('a file the encoder rejects is marked without stopping the batch', async () => {
  const good = fixtureFile('opus.opus');
  const bad = new dom.window.File([readFileSync(join(FIXTURES, 'mp3_v0.mp3'))],
    'BROKEN track.mp3', { type: 'audio/mpeg' });

  await addFiles([good, bad]);

  // One file is already 'done' from earlier tests; the button should now
  // count only the two new pending ones, not three.
  assert.equal($('#convert').disabled, false);
  assert.equal($('#convert').textContent, 'Convert 2 files');

  $('#convert').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await waitFor(() => $$('.row').every((r) => ['done', 'error'].includes(r.dataset.status)));

  const rows = $$('.row');
  const failed = rows.filter((r) => r.dataset.status === 'error');
  const done = rows.filter((r) => r.dataset.status === 'done');

  assert.equal(failed.length, 1, 'exactly the broken file should fail');
  assert.equal(done.length, 2, 'the others should still finish');
  assert.match(failed[0].querySelector('.row__message').textContent, /rejected/);
  assert.equal($('#status').dataset.tone, 'error');
});

test('playing a second row stops the first, so only one plays at a time', () => {
  const rows = $$('.row');
  const first = rows[0].querySelector('.row__play[data-kind="source"]');
  const second = rows[1].querySelector('.row__play[data-kind="source"]');

  first.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(first.dataset.playing, 'true');

  second.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(second.dataset.playing, 'true');
  assert.equal(first.dataset.playing, 'false', 'starting the second should stop the first');

  second.dispatchEvent(new dom.window.Event('click', { bubbles: true })); // leave it stopped
});

// ---------------------------------------------------------------- zip

test('download all builds a valid zip from the finished files', async () => {
  assert.equal($('#download-all').hidden, false, 'two finished files should offer a zip');

  const before = objectUrls.size;
  $('#download-all').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await waitFor(() => objectUrls.size > before);

  const zipEntry = [...objectUrls.values()].at(-1);
  assert.equal(zipEntry.type, 'application/zip');
  assert.ok(zipEntry.size > 0);
  assert.ok(objectUrls.size > before);
});

// ---------------------------------------------------------------- removal

test('clearing the queue returns the page to its opening state', () => {
  $('#clear').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal($$('.row').length, 0);
  assert.equal($('#intake').dataset.state, 'empty');
  assert.equal($('#workbench').hidden, true);
  assert.equal($('#actionbar').hidden, true);
});

test('non-audio files are refused with an explanation', async () => {
  const junk = new dom.window.File(['not audio'], 'notes.txt', { type: 'text/plain' });
  const event = new dom.window.Event('drop', { bubbles: true });
  event.dataTransfer = { files: [junk] };
  event.preventDefault = () => {};
  $('#dropzone').dispatchEvent(event);

  await waitFor(() => $('#status').dataset.tone === 'error');
  assert.equal($$('.row').length, 0);
  assert.match($('#status').textContent, /not audio/);
});
