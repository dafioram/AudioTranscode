/**
 * Minimal ZIP writer, store method only.
 *
 * Encoded audio is already compressed, so deflating it again costs CPU and
 * saves close to nothing. Storing keeps this to about a hundred lines with no
 * dependency and no wasm.
 *
 * Limits: no ZIP64, so the archive must stay under 4 GB and hold fewer than
 * 65,535 files. buildZip throws if either is exceeded.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Date and time in the DOS format ZIP headers use. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Strip anything that breaks archivers or escapes the extract directory.
 * Windows reserves \ / : * ? " < > | and disallows trailing dots and spaces.
 */
export function safeEntryName(name, fallback = 'track') {
  // Split on both separators and drop empty and traversal segments outright,
  // so "../../etc/passwd" can never resolve outside the extract directory.
  let out = String(name || '')
    .split(/[\\/]+/)
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('-')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[:*?"<>|]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/[. ]+$/, '')
    .trim();
  if (!out) out = fallback;
  // Keep well under the 255-byte limit once UTF-8 encoded.
  if (out.length > 180) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 6 ? out.slice(dot) : '';
    out = out.slice(0, 180 - ext.length) + ext;
  }
  return out;
}

/** Append `-2`, `-3` … before the extension when a name is already taken. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  let candidate = `${stem}-${n}${ext}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * @param {Array<{name: string, bytes: Uint8Array, date?: Date}>} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`A zip can hold ${MAX_ENTRIES} files. Download in smaller batches.`);
  }

  const encoder = new TextEncoder();
  const taken = new Set();
  const prepared = entries.map((entry) => {
    const name = uniqueName(safeEntryName(entry.name), taken);
    return {
      nameBytes: encoder.encode(name),
      bytes: entry.bytes,
      crc: crc32(entry.bytes),
      stamp: dosStamp(entry.date || new Date()),
    };
  });

  const localSize = prepared.reduce((n, e) => n + 30 + e.nameBytes.length + e.bytes.length, 0);
  const centralSize = prepared.reduce((n, e) => n + 46 + e.nameBytes.length, 0);
  const total = localSize + centralSize + 22;

  if (total > MAX_BYTES) {
    throw new Error('That batch is over 4 GB, which is more than a zip can hold. Download in smaller batches.');
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;

  const u16 = (v) => { view.setUint16(pos, v, true); pos += 2; };
  const u32 = (v) => { view.setUint32(pos, v >>> 0, true); pos += 4; };
  const raw = (b) => { out.set(b, pos); pos += b.length; };

  const offsets = [];
  for (const e of prepared) {
    offsets.push(pos);
    u32(LOCAL_SIG);
    u16(20);            // version needed
    u16(UTF8_FLAG);
    u16(0);             // method: store
    u16(e.stamp.time);
    u16(e.stamp.day);
    u32(e.crc);
    u32(e.bytes.length);
    u32(e.bytes.length);
    u16(e.nameBytes.length);
    u16(0);             // extra field length
    raw(e.nameBytes);
    raw(e.bytes);
  }

  const centralStart = pos;
  prepared.forEach((e, i) => {
    u32(CENTRAL_SIG);
    u16(20);            // version made by
    u16(20);            // version needed
    u16(UTF8_FLAG);
    u16(0);
    u16(e.stamp.time);
    u16(e.stamp.day);
    u32(e.crc);
    u32(e.bytes.length);
    u32(e.bytes.length);
    u16(e.nameBytes.length);
    u16(0);             // extra
    u16(0);             // comment
    u16(0);             // disk number start
    u16(0);             // internal attributes
    u32(0);             // external attributes
    u32(offsets[i]);
    raw(e.nameBytes);
  });

  // Capture this before writing the EOCD, since every write advances `pos`.
  const centralBytes = pos - centralStart;

  u32(EOCD_SIG);
  u16(0);               // this disk number
  u16(0);               // disk holding the central directory
  u16(prepared.length); // entries on this disk
  u16(prepared.length); // entries in total
  u32(centralBytes);
  u32(centralStart);
  u16(0);               // archive comment length

  return out;
}
