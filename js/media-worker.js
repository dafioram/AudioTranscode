/**
 * Background thread for the two jobs heavy enough to stutter the UI:
 * parsing tags out of a file, and assembling the batch zip.
 *
 * Encoding itself is not here. ffmpeg.wasm already runs the codec in a worker
 * of its own, so wrapping it in a second one would just nest workers for no
 * gain. See README for the layout.
 */
import { readMetadata } from './metadata.js';
import { buildZip } from './zipwriter.js';

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;

  try {
    if (type === 'read-metadata') {
      const bytes = new Uint8Array(payload.buffer);
      const track = readMetadata(bytes, payload.filename);

      // Cover bytes are transferred rather than copied; everything else is
      // small enough that structured cloning it is free.
      const transfer = [];
      let cover = null;
      if (track.cover && track.cover.bytes && track.cover.bytes.length) {
        const copy = track.cover.bytes.slice();
        cover = { mime: track.cover.mime, buffer: copy.buffer };
        transfer.push(copy.buffer);
      }

      self.postMessage({ id, ok: true, result: { ...track, cover } }, transfer);
      return;
    }

    if (type === 'build-zip') {
      const entries = payload.entries.map((e) => ({
        name: e.name,
        bytes: new Uint8Array(e.buffer),
      }));
      const zipped = buildZip(entries);
      self.postMessage({ id, ok: true, result: { buffer: zipped.buffer } }, [zipped.buffer]);
      return;
    }

    throw new Error(`Unknown worker task: ${type}`);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: String((error && error.message) || error),
    });
  }
};
