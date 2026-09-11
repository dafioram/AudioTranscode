/**
 * UI controller.
 *
 * Threading: tag parsing and zip assembly go to media-worker.js; encoding goes
 * to ffmpeg.wasm, which runs the codec in a worker it manages itself. The main
 * thread only ever touches DOM.
 */
import {
  FORMATS, FORMAT_ORDER, DEFAULT_FORMAT, INPUT_ACCEPT,
  defaultQuality, getQuality, estimateSize,
} from './formats.js';
import { convertFile, loadEngine, engineReady, recentLog } from './converter.js';
import { ENGINE_DOWNLOAD_MB } from './config.js';

// ------------------------------------------------------------------ state

const state = {
  items: [],
  formatId: DEFAULT_FORMAT,
  qualityId: defaultQuality(DEFAULT_FORMAT),
  keepTags: true,
  running: false,
};

let nextId = 1;

/**
 * Items a click on Convert will actually do something with. Shared by
 * refreshTotals() (button label/enabled state, size estimate) and
 * convertAll() (the real queue), so they can't drift apart the way they
 * did before: the button used to stay enabled and labelled "Convert 1 file"
 * even after that one file finished, because its criteria only excluded
 * 'reading' — not 'done' — while the actual queue excluded both. Clicking
 * it then hit an empty queue and did nothing at all, silently.
 */
function pendingItems(items) {
  return items.filter((i) => i.status !== 'reading' && i.status !== 'done');
}

// ------------------------------------------------------------------ playback

// One shared element rather than one per row: only one thing should play at
// a time, and it keeps track of "what's playing" in a single place.
const player = new Audio();
let nowPlaying = null; // { itemId, kind: 'source'|'result', button }

const PLAY_GLYPH = 'M2.5 1.5 L10 6 L2.5 10.5 Z';
const PAUSE_GLYPH = 'M2.5 1.5 H4.5 V10.5 H2.5 Z M7.5 1.5 H9.5 V10.5 H7.5 Z';

function setButtonPlaying(button, playing, baseLabel) {
  button.dataset.playing = String(playing);
  button.querySelector('path')?.setAttribute('d', playing ? PAUSE_GLYPH : PLAY_GLYPH);
  button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${baseLabel}`);
  const label = button.querySelector('span');
  if (label) label.textContent = playing ? `Pause ${baseLabel}` : `Play ${baseLabel}`;
}

function stopPlayback() {
  if (!nowPlaying) return;
  setButtonPlaying(nowPlaying.button, false, nowPlaying.button.dataset.label);
  nowPlaying = null;
  player.pause();
}

player.addEventListener('ended', stopPlayback);
player.addEventListener('error', () => {
  if (!nowPlaying) return;
  const item = state.items.find((i) => i.id === nowPlaying.itemId);
  if (item) {
    item.message = "This browser can't play that file directly, but it can still convert it.";
    renderRow(item);
  }
  stopPlayback();
});

function togglePlay(item, kind, button) {
  const isThisOne = nowPlaying && nowPlaying.itemId === item.id && nowPlaying.kind === kind;

  if (isThisOne) {
    stopPlayback();
    return;
  }
  stopPlayback();

  let url;
  let label;
  if (kind === 'source') {
    item.sourceUrl ||= URL.createObjectURL(item.file);
    url = item.sourceUrl;
    label = 'original';
  } else {
    if (!item.result) return;
    url = item.result.url;
    label = 'converted';
  }

  button.dataset.label = label;
  if (player.src !== url) player.src = url;
  player.currentTime = 0;
  const playPromise = player.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      // Autoplay/decoding rejection; the 'error' listener covers bad files,
      // this covers the rest, e.g. the browser blocking playback outright.
      stopPlayback();
    });
  }

  nowPlaying = { itemId: item.id, kind, button };
  setButtonPlaying(button, true, label);
}

const el = (id) => document.getElementById(id);
const ui = {
  intake: el('intake'),
  dropzone: el('dropzone'),
  picker: el('picker'),
  browse: el('browse'),
  workbench: el('workbench'),
  formats: el('formats'),
  qualities: el('qualities'),
  qualityNote: el('quality-note'),
  plays: el('plays'),
  keepTags: el('keep-tags'),
  queue: el('queue'),
  addMore: el('add-more'),
  clear: el('clear'),
  actionbar: el('actionbar'),
  status: el('status'),
  convert: el('convert'),
  downloadAll: el('download-all'),
  rowTemplate: el('row-template'),
};

ui.picker.accept = INPUT_ACCEPT;

// ------------------------------------------------------------------ worker

const worker = new Worker(new URL('./media-worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let taskId = 0;

worker.addEventListener('message', (event) => {
  const { id, ok, result, error } = event.data;
  const task = pending.get(id);
  if (!task) return;
  pending.delete(id);
  ok ? task.resolve(result) : task.reject(new Error(error));
});

worker.addEventListener('error', (event) => {
  for (const task of pending.values()) task.reject(new Error(event.message));
  pending.clear();
});

function ask(type, payload, transfer = []) {
  const id = ++taskId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
}

// ------------------------------------------------------------------ helpers

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  return `${Math.round(mb)} MB`;
}

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatBitrate(bps) {
  if (!bps || !isFinite(bps)) return '';
  return `${Math.round(bps / 1000)} kbps`;
}

const CONTAINER_NAMES = {
  mp3: 'MP3', mp4: 'AAC', flac: 'FLAC', wav: 'WAV',
  opus: 'Opus', vorbis: 'Vorbis', ogg: 'Ogg', aiff: 'AIFF', webm: 'WebM',
};

function describeSource(item) {
  const t = item.track;
  const parts = [CONTAINER_NAMES[t.container] || 'Audio'];
  if (t.duration) parts.push(formatDuration(t.duration));
  if (t.bitrate) parts.push(formatBitrate(t.bitrate));
  parts.push(formatBytes(item.file.size));
  return parts.join('  ·  ');
}

/** Filename for the converted file, built from tags when we have them. */
function outputName(item) {
  const fmt = FORMATS[state.formatId];
  const tags = effectiveTags(item);
  const stem = [tags.artist, tags.title].filter(Boolean).join(' - ')
    || item.file.name.replace(/\.[^.]+$/, '')
    || 'track';
  return `${stem}.${fmt.ext}`;
}

function effectiveTags(item) {
  const t = item.track;
  return {
    title: item.edits.title ?? t.title ?? '',
    artist: item.edits.artist ?? t.artist ?? '',
    album: item.edits.album ?? t.album ?? '',
    track: item.edits.track ?? t.track ?? '',
  };
}

/** Tags handed to ffmpeg. Blank when the user has switched tags off. */
function tagsForEncode(item) {
  if (!state.keepTags) return {};
  const tags = effectiveTags(item);
  const out = {};
  // Only send fields the user actually changed; -map_metadata 0 carries the rest.
  for (const key of ['title', 'artist', 'album', 'track']) {
    if (item.edits[key] !== undefined && item.edits[key] !== '') out[key] = item.edits[key];
  }
  // A title invented from the filename should still be written out.
  if (item.track.titleFromFilename && !out.title && tags.title) out.title = tags.title;
  return out;
}

// ------------------------------------------------------------------ intake

function isProbablyAudio(file) {
  if (file.type.startsWith('audio/')) return true;
  if (file.type === 'video/mp4' || file.type === 'video/webm') return true;
  return /\.(mp3|m4a|mp4|aac|flac|wav|ogg|oga|opus|aiff?|wma|alac|webm|mka|ape)$/i.test(file.name);
}

async function addFiles(fileList) {
  const files = [...fileList].filter(isProbablyAudio);
  const rejected = fileList.length - files.length;

  if (!files.length) {
    setStatus(
      rejected
        ? 'Those files are not audio. Add MP3, M4A, FLAC, WAV, OGG or Opus files.'
        : 'No files were added.',
      'error',
    );
    return;
  }

  for (const file of files) {
    const item = {
      id: nextId++,
      file,
      track: { container: 'unknown', title: file.name, duration: 0, cover: null },
      coverUrl: null,
      sourceUrl: null,
      edits: {},
      status: 'reading',
      progress: 0,
      message: '',
      result: null,
    };
    state.items.push(item);
    renderRow(item);
  }

  ui.intake.dataset.state = 'loaded';
  ui.workbench.hidden = false;
  ui.actionbar.hidden = false;
  refreshTotals();

  if (rejected) {
    setStatus(`${rejected} file${rejected > 1 ? 's were' : ' was'} skipped for not being audio.`);
  }

  // Read tags one at a time so a big drop does not spike memory.
  for (const item of state.items.filter((i) => i.status === 'reading')) {
    await readTags(item);
  }

  // Warm the encoder up while the person is still choosing settings.
  if (!engineReady()) {
    loadEngine().catch(() => { /* reported when they press Convert */ });
  }
}

async function readTags(item) {
  try {
    const buffer = await item.file.arrayBuffer();
    const track = await ask('read-metadata', { buffer, filename: item.file.name }, [buffer]);

    if (track.cover && track.cover.buffer) {
      const bytes = new Uint8Array(track.cover.buffer);
      track.cover = { mime: track.cover.mime, bytes };
      item.coverUrl = URL.createObjectURL(new Blob([bytes], { type: track.cover.mime }));
    }
    item.track = track;

    // Containers we do not parse still have a duration the browser can read.
    if (!track.duration) {
      const measured = await measureDuration(item.file);
      if (measured) item.track.duration = measured;
    }
    item.status = 'ready';
  } catch (error) {
    // A tag we cannot read is not a reason to refuse the file.
    item.status = 'ready';
    item.message = 'Tags could not be read. The audio will still convert.';
  }
  renderRow(item);
  refreshTotals();
}

/** Fall back to the browser's own decoder for duration. */
function measureDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value) => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      resolve(value);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    audio.src = url;
  });
}

// ------------------------------------------------------------------ rendering

function renderRow(item) {
  let row = ui.queue.querySelector(`[data-id="${item.id}"]`);
  if (!row) {
    row = ui.rowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.id = String(item.id);
    wireRow(row, item);
    ui.queue.append(row);
  }

  const tags = effectiveTags(item);
  row.dataset.status = item.status;

  const img = row.querySelector('.row__art img');
  if (item.coverUrl) {
    img.src = item.coverUrl;
    img.hidden = false;
  } else {
    img.hidden = true;
  }

  row.querySelector('.row__title').textContent = tags.title || item.file.name;
  const artistLine = [tags.artist, tags.album].filter(Boolean).join(' — ');
  row.querySelector('.row__artist').textContent = artistLine;
  row.querySelector('.row__source').textContent =
    item.status === 'reading' ? 'Reading tags…' : describeSource(item);

  const message = row.querySelector('.row__message');
  message.textContent = item.message || '';
  message.hidden = !item.message;

  const edit = row.querySelector('.row__edit');
  edit.hidden = item.status === 'reading';

  const save = row.querySelector('.row__save');
  const playResult = row.querySelector('.row__play[data-kind="result"]');
  if (item.status === 'done' && item.result) {
    save.hidden = false;
    save.href = item.result.url;
    save.download = item.result.name;
    save.textContent = `Download ${FORMATS[item.result.formatId].name}`;
    playResult.hidden = false;
  } else {
    save.hidden = true;
    playResult.hidden = true;
  }

  renderSizes(row, item);
}

function renderSizes(row, item) {
  const box = row.querySelector('.sizes');
  const sourceSize = item.file.size;
  const done = item.status === 'done' && item.result;
  const targetSize = done
    ? item.result.size
    : estimateSize(state.formatId, state.qualityId, item.track);

  if (item.status === 'reading' || targetSize === null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const scale = Math.max(sourceSize, targetSize) || 1;
  const fromBar = row.querySelector('.sizes__bar--from');
  const toBar = row.querySelector('.sizes__bar--to');

  fromBar.querySelector('.sizes__fill').style.width = `${(sourceSize / scale) * 100}%`;
  fromBar.querySelector('.sizes__label').textContent =
    `${formatBytes(sourceSize)} now`;

  // While encoding, the target bar fills toward its estimate as progress runs.
  const converting = item.status === 'converting';
  const shownSize = converting ? targetSize * item.progress : targetSize;
  toBar.querySelector('.sizes__fill').style.width =
    `${Math.max(2, (shownSize / scale) * 100)}%`;

  const targetLabel = done
    ? `${formatBytes(targetSize)} ${FORMATS[item.result.formatId].name}`
    : `${formatBytes(targetSize)} ${FORMATS[state.formatId].name}, estimated`;
  toBar.querySelector('.sizes__label').textContent =
    item.status === 'converting' ? `Converting… ${Math.round(item.progress * 100)}%` : targetLabel;

  const verdict = row.querySelector('.sizes__verdict');
  if (item.status === 'converting') {
    verdict.textContent = '';
    return;
  }
  const delta = sourceSize - targetSize;
  const percent = Math.round(Math.abs(delta) / sourceSize * 100);
  if (Math.abs(delta) < sourceSize * 0.02) {
    verdict.textContent = 'About the same size';
    verdict.dataset.direction = 'same';
  } else if (delta > 0) {
    verdict.textContent = `Saves ${formatBytes(delta)}, about ${percent}% smaller`;
    verdict.dataset.direction = 'smaller';
  } else {
    verdict.textContent = `Adds ${formatBytes(-delta)}, about ${percent}% larger`;
    verdict.dataset.direction = 'bigger';
  }
}

function wireRow(row, item) {
  row.querySelector('.row__remove').addEventListener('click', () => removeItem(item));

  for (const button of row.querySelectorAll('.row__play')) {
    const kind = button.dataset.kind;
    button.addEventListener('click', () => togglePlay(item, kind, button));
  }

  const form = row.querySelector('.tagform');
  row.querySelector('.row__edit').addEventListener('click', (event) => {
    const open = form.hidden;
    form.hidden = !open;
    event.currentTarget.textContent = open ? 'Hide tags' : 'Edit tags';
    if (open) {
      const tags = effectiveTags(item);
      for (const input of form.querySelectorAll('input')) {
        input.value = tags[input.dataset.tag] || '';
      }
      form.querySelector('input').focus();
    }
  });

  form.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.dataset.tag) return;
    item.edits[input.dataset.tag] = input.value;
    row.querySelector('.row__title').textContent =
      effectiveTags(item).title || item.file.name;
    const tags = effectiveTags(item);
    row.querySelector('.row__artist').textContent =
      [tags.artist, tags.album].filter(Boolean).join(' — ');
  });
}

function removeItem(item) {
  if (nowPlaying && nowPlaying.itemId === item.id) stopPlayback();
  if (item.coverUrl) URL.revokeObjectURL(item.coverUrl);
  if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);
  if (item.result) URL.revokeObjectURL(item.result.url);
  state.items = state.items.filter((i) => i !== item);
  ui.queue.querySelector(`[data-id="${item.id}"]`)?.remove();

  if (!state.items.length) {
    ui.intake.dataset.state = 'empty';
    ui.workbench.hidden = true;
    ui.actionbar.hidden = true;
  }
  refreshTotals();
}

function renderAllRows() {
  for (const item of state.items) renderRow(item);
}

// ------------------------------------------------------------------ controls

function renderFormats() {
  ui.formats.replaceChildren();
  for (const id of FORMAT_ORDER) {
    const fmt = FORMATS[id];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fmt';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(id === state.formatId));

    const dot = document.createElement('span');
    dot.className = 'fmt__dot';

    const name = document.createElement('span');
    name.className = 'fmt__name';
    name.textContent = fmt.name;

    const note = document.createElement('span');
    note.className = 'fmt__note';
    note.textContent = fmt.summary;

    button.append(dot, name, note);

    if (id === 'm4a') {
      const flag = document.createElement('span');
      flag.className = 'fmt__flag';
      flag.textContent = 'Recommended: full quality, smaller file';
      button.append(flag);
    }

    button.addEventListener('click', () => selectFormat(id));
    ui.formats.append(button);
  }
}

function selectFormat(id) {
  state.formatId = id;
  state.qualityId = defaultQuality(id);
  renderFormats();
  renderQualities();
  renderAllRows();
  refreshTotals();
}

function renderQualities() {
  const fmt = FORMATS[state.formatId];
  ui.qualities.replaceChildren();

  for (const q of fmt.qualities) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'seg';
    button.textContent = q.label;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(q.id === state.qualityId));
    button.addEventListener('click', () => {
      state.qualityId = q.id;
      renderQualities();
      renderAllRows();
      refreshTotals();
    });
    ui.qualities.append(button);
  }

  ui.qualityNote.textContent = getQuality(state.formatId, state.qualityId).note || '';
  ui.plays.textContent = `Plays on: ${fmt.plays}`;
}

function setStatus(text, tone = '') {
  ui.status.textContent = text;
  if (tone) ui.status.dataset.tone = tone;
  else delete ui.status.dataset.tone;
}

function refreshTotals() {
  const pending = pendingItems(state.items);
  const done = state.items.filter((i) => i.status === 'done');

  ui.convert.disabled = state.running || !pending.length;
  if (state.running) {
    ui.convert.textContent = 'Converting…';
  } else if (!pending.length && done.length) {
    ui.convert.textContent = 'All converted';
  } else if (pending.length === 1) {
    ui.convert.textContent = 'Convert 1 file';
  } else {
    ui.convert.textContent = `Convert ${pending.length} files`;
  }

  ui.downloadAll.hidden = done.length < 2;

  if (state.running || !state.items.length) return;

  if (done.length && done.length === state.items.length) {
    const before = state.items.reduce((n, i) => n + i.file.size, 0);
    const after = done.reduce((n, i) => n + i.result.size, 0);
    const saved = before - after;
    setStatus(
      saved > 0
        ? `Done. ${formatBytes(before)} became ${formatBytes(after)}, saving ${formatBytes(saved)}.`
        : `Done. ${formatBytes(before)} became ${formatBytes(after)}.`,
      'done',
    );
    return;
  }

  const totalBefore = pending.reduce((n, i) => n + i.file.size, 0);
  let totalAfter = 0;
  let unknown = false;
  for (const item of pending) {
    const size = estimateSize(state.formatId, state.qualityId, item.track);
    if (size === null) unknown = true;
    else totalAfter += size;
  }

  if (!pending.length) {
    setStatus('');
  } else if (unknown || !totalAfter) {
    setStatus(`${pending.length} file${pending.length === 1 ? '' : 's'} ready.`);
  } else {
    const saved = totalBefore - totalAfter;
    const verb = saved >= 0 ? 'saving about' : 'adding about';
    setStatus(
      `${pending.length} file${pending.length === 1 ? '' : 's'}: ` +
      `${formatBytes(totalBefore)} to about ${formatBytes(totalAfter)}, ` +
      `${verb} ${formatBytes(Math.abs(saved))}.`,
    );
  }
}

// ------------------------------------------------------------------ converting

async function convertAll() {
  const queue = pendingItems(state.items);
  if (!queue.length) {
    // Shouldn't happen — the button is disabled in this state — but a
    // visible message beats the silent no-op this used to be if some race
    // ever gets here anyway.
    setStatus('Nothing left to convert. Add another file to convert more.');
    return;
  }

  state.running = true;
  refreshTotals();

  if (!engineReady()) {
    setStatus(`Loading the encoder, about ${ENGINE_DOWNLOAD_MB} MB on first use…`);
    try {
      await loadEngine((stage, ratio) => setStatus(`${stage}… ${Math.round(ratio * 100)}%`));
    } catch (error) {
      state.running = false;
      setStatus(
        'The encoder could not be downloaded. Check your connection and try again.',
        'error',
      );
      refreshTotals();
      return;
    }
  }

  let index = 0;
  for (const item of queue) {
    index += 1;
    item.status = 'converting';
    item.progress = 0;
    item.message = '';
    renderRow(item);
    setStatus(`Converting ${index} of ${queue.length}…`);

    try {
      const result = await convertFile({
        file: item.file,
        formatId: state.formatId,
        qualityId: state.qualityId,
        cover: state.keepTags ? item.track.cover : null,
        tags: tagsForEncode(item),
        onProgress: (ratio) => {
          item.progress = ratio;
          const row = ui.queue.querySelector(`[data-id="${item.id}"]`);
          if (row) renderSizes(row, item);
        },
      });

      if (item.result) URL.revokeObjectURL(item.result.url);
      const blob = new Blob([result.bytes], { type: result.mime });
      item.result = {
        url: URL.createObjectURL(blob),
        name: outputName(item),
        size: blob.size,
        formatId: state.formatId,
        bytes: result.bytes,
      };
      item.status = 'done';
      item.message = result.droppedArt
        ? 'Converted without the artwork, which this format would not accept.'
        : '';
    } catch (error) {
      item.status = 'error';
      item.message = String(error.message || error).split('\n')[0]
        || 'This file could not be converted.';
    }
    renderRow(item);
  }

  state.running = false;

  const failed = state.items.filter((i) => i.status === 'error').length;
  refreshTotals();
  if (failed) {
    setStatus(
      `${failed} file${failed === 1 ? '' : 's'} could not be converted. The rest are ready to download.`,
      'error',
    );
  }
}

async function downloadAll() {
  const done = state.items.filter((i) => i.status === 'done' && i.result);
  if (!done.length) return;

  const previous = ui.downloadAll.textContent;
  ui.downloadAll.disabled = true;
  ui.downloadAll.textContent = 'Building zip…';

  try {
    // Copy the bytes: the worker takes ownership of what we transfer.
    const entries = done.map((item) => {
      const copy = item.result.bytes.slice();
      return { name: item.result.name, buffer: copy.buffer };
    });
    const { buffer } = await ask('build-zip', { entries }, entries.map((e) => e.buffer));

    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `transcoded-${FORMATS[state.formatId].ext}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    setStatus(String(error.message || error), 'error');
  } finally {
    ui.downloadAll.disabled = false;
    ui.downloadAll.textContent = previous;
  }
}

// ------------------------------------------------------------------ events

ui.browse.addEventListener('click', (event) => {
  event.stopPropagation();
  ui.picker.click();
});
ui.addMore.addEventListener('click', () => ui.picker.click());
ui.dropzone.addEventListener('click', () => ui.picker.click());

ui.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    ui.picker.click();
  }
});

ui.picker.addEventListener('change', () => {
  addFiles(ui.picker.files);
  ui.picker.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  ui.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    ui.dropzone.classList.add('is-hot');
  });
}
for (const type of ['dragleave', 'drop']) {
  ui.dropzone.addEventListener(type, () => ui.dropzone.classList.remove('is-hot'));
}
ui.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});

// Stop a stray drop elsewhere on the page from navigating away from the app.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

ui.keepTags.addEventListener('change', () => {
  state.keepTags = ui.keepTags.checked;
});

ui.clear.addEventListener('click', () => {
  for (const item of [...state.items]) removeItem(item);
  setStatus('');
});

ui.convert.addEventListener('click', convertAll);
ui.downloadAll.addEventListener('click', downloadAll);

window.addEventListener('beforeunload', (event) => {
  if (state.running) event.preventDefault();
});

renderFormats();
renderQualities();
