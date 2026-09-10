/**
 * Tag and container reader.
 *
 * Pure functions over a Uint8Array so the same code runs inside the Web Worker
 * and inside the Node test suite. Nothing here touches the DOM.
 *
 * Returns a Track shape:
 *   { container, title, artist, album, albumArtist, track, trackTotal,
 *     year, genre, duration, sampleRate, channels, bitrate,
 *     cover: { mime, bytes } | null }
 */

const LATIN1 = new TextDecoder('latin1');
const UTF8 = new TextDecoder('utf-8');
const UTF16LE = new TextDecoder('utf-16le');
const UTF16BE = new TextDecoder('utf-16be');

const ID3_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge',
  'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B',
  'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop',
  'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental',
  'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alt. Rock',
  'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop',
  'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial',
  'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy',
  'Cult', 'Gangsta Rap', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle',
  'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave',
  'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz',
  'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

function emptyTrack() {
  return {
    container: 'unknown',
    title: '', artist: '', album: '', albumArtist: '',
    track: '', trackTotal: '', year: '', genre: '',
    duration: 0, sampleRate: 0, channels: 0, bitrate: 0,
    cover: null,
  };
}

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const synchsafe = (b, o) =>
  ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function ascii(bytes, offset, length) {
  return LATIN1.decode(bytes.subarray(offset, offset + length));
}

function clean(text) {
  return String(text || '').replace(/\u0000+$/g, '').trim();
}

// ---------------------------------------------------------------- sniffing

export function sniff(bytes) {
  if (bytes.length < 12) return 'unknown';
  const head = ascii(bytes, 0, 4);

  if (head === 'fLaC') return 'flac';
  if (head === 'OggS') return 'ogg';
  if (head === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  if (head === 'FORM') return 'aiff';
  if (ascii(bytes, 4, 4) === 'ftyp') return 'mp4';
  if (head.startsWith('ID3')) return 'mp3';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  if (head === '\u001aE\u00df\u00a3') return 'webm';
  return 'unknown';
}

// ---------------------------------------------------------------- ID3v2

function decodeId3Text(encoding, bytes) {
  switch (encoding) {
    case 0: return LATIN1.decode(bytes);
    case 1: {
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return UTF16LE.decode(bytes.subarray(2));
      }
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return UTF16BE.decode(bytes.subarray(2));
      }
      return UTF16LE.decode(bytes);
    }
    case 2: return UTF16BE.decode(bytes);
    case 3: return UTF8.decode(bytes);
    default: return LATIN1.decode(bytes);
  }
}

/** Index of the string terminator for a given ID3 text encoding. */
function terminatorAt(bytes, start, encoding) {
  const wide = encoding === 1 || encoding === 2;
  if (wide) {
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    }
  } else {
    for (let i = start; i < bytes.length; i++) if (bytes[i] === 0) return i;
  }
  return bytes.length;
}

function stripUnsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[n++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/** @returns {{track: object, tagSize: number}} */
export function readId3v2(bytes) {
  const track = emptyTrack();
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return { track, tagSize: 0 };

  const major = bytes[3];
  const flags = bytes[5];
  const size = synchsafe(bytes, 6);
  const tagSize = size + 10;
  let body = bytes.subarray(10, Math.min(10 + size, bytes.length));
  if (flags & 0x80) body = stripUnsync(body);

  // An extended header sits at the front of the body when bit 6 is set.
  let pos = 0;
  if (flags & 0x40) {
    pos += major >= 4 ? synchsafe(body, 0) : be32(body, 0) + 4;
  }

  const idLen = major === 2 ? 3 : 4;
  const headerLen = major === 2 ? 6 : 10;

  while (pos + headerLen <= body.length) {
    const id = ascii(body, pos, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    let frameSize;
    if (major === 2) frameSize = be24(body, pos + 3);
    else if (major >= 4) frameSize = synchsafe(body, pos + 4);
    else frameSize = be32(body, pos + 4);

    if (frameSize <= 0 || pos + headerLen + frameSize > body.length) break;
    const data = body.subarray(pos + headerLen, pos + headerLen + frameSize);
    applyId3Frame(track, id, data);
    pos += headerLen + frameSize;
  }

  return { track, tagSize };
}

function applyId3Frame(track, id, data) {
  const TEXT = {
    TIT2: 'title', TT2: 'title',
    TPE1: 'artist', TP1: 'artist',
    TALB: 'album', TAL: 'album',
    TPE2: 'albumArtist', TP2: 'albumArtist',
    TRCK: 'track', TRK: 'track',
    TCON: 'genre', TCO: 'genre',
    TYER: 'year', TYE: 'year', TDRC: 'year', TDRL: 'year',
  };

  if (TEXT[id]) {
    const value = clean(decodeId3Text(data[0], data.subarray(1)));
    if (!value) return;
    let final = value;

    if (TEXT[id] === 'genre') {
      // "(17)" and "17" both mean an ID3v1 genre index.
      const numeric = final.match(/^\(?(\d+)\)?$/);
      if (numeric) final = ID3_GENRES[Number(numeric[1])] || final;
    }
    if (TEXT[id] === 'track') {
      const [num, total] = final.split('/');
      track.track = clean(num);
      if (total) track.trackTotal = clean(total);
      return;
    }
    if (TEXT[id] === 'year') final = final.slice(0, 4);

    if (!track[TEXT[id]]) track[TEXT[id]] = final;
    return;
  }

  if ((id === 'APIC' || id === 'PIC') && !track.cover) {
    const encoding = data[0];
    let cursor = 1;
    let mime;

    if (id === 'PIC') {
      const kind = ascii(data, 1, 3).toUpperCase();
      mime = kind === 'PNG' ? 'image/png' : 'image/jpeg';
      cursor = 4;
    } else {
      const end = terminatorAt(data, 1, 0);
      mime = clean(LATIN1.decode(data.subarray(1, end))).toLowerCase() || 'image/jpeg';
      if (!mime.includes('/')) mime = 'image/' + mime;
      cursor = end + 1;
    }

    cursor += 1; // picture type byte
    const descEnd = terminatorAt(data, cursor, encoding);
    cursor = descEnd + (encoding === 1 || encoding === 2 ? 2 : 1);
    if (cursor < data.length) {
      track.cover = { mime, bytes: data.slice(cursor) };
    }
  }
}

// ---------------------------------------------------------------- MP3

const MP3_BITRATES = {
  // MPEG1 Layer III
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  // MPEG2 / 2.5 Layer III
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export function readMp3(bytes) {
  const { track, tagSize } = readId3v2(bytes);
  track.container = 'mp3';

  // Locate the first frame sync after any ID3 tag.
  let start = -1;
  for (let i = tagSize; i < Math.min(bytes.length - 4, tagSize + 200000); i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      const layerBits = (bytes[i + 1] >> 1) & 0x03;
      const versionBits = (bytes[i + 1] >> 3) & 0x03;
      if (layerBits !== 0 && versionBits !== 1) { start = i; break; }
    }
  }
  if (start < 0) return track;

  const h1 = bytes[start + 1], h2 = bytes[start + 2], h3 = bytes[start + 3];
  const versionBits = (h1 >> 3) & 0x03;      // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = (h1 >> 1) & 0x03;        // 3 = Layer I, 2 = II, 1 = III
  const layer = 4 - layerBits;
  const mpeg1 = versionBits === 3;
  const bitrateTable = MP3_BITRATES[`${mpeg1 ? 1 : 2}-${layer}`] || MP3_BITRATES['1-3'];
  const bitrate = bitrateTable[(h2 >> 4) & 0x0f];
  const sampleRate = (MP3_RATES[versionBits] || MP3_RATES[3])[(h2 >> 2) & 0x03];
  const mono = ((h3 >> 6) & 0x03) === 3;

  track.sampleRate = sampleRate;
  track.channels = mono ? 1 : 2;
  track.bitrate = bitrate * 1000;
  if (!sampleRate || !bitrate) return track;

  const samplesPerFrame = layer === 1 ? 384 : (layer === 2 || mpeg1) ? 1152 : 576;

  // Xing/Info (VBR) header sits at a fixed offset that depends on the mode.
  const xingOffset = start + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  const marker = xingOffset + 4 <= bytes.length ? ascii(bytes, xingOffset, 4) : '';

  if (marker === 'Xing' || marker === 'Info') {
    const flags = be32(bytes, xingOffset + 4);
    let cursor = xingOffset + 8;
    if (flags & 0x01) {
      const frames = be32(bytes, cursor);
      cursor += 4;
      track.duration = (frames * samplesPerFrame) / sampleRate;
      if (flags & 0x02) {
        const streamBytes = be32(bytes, cursor);
        if (track.duration > 0) track.bitrate = Math.round((streamBytes * 8) / track.duration);
      }
      return track;
    }
  }

  // No VBR header: treat it as constant bitrate.
  track.duration = ((bytes.length - tagSize) * 8) / (bitrate * 1000);
  return track;
}

// ---------------------------------------------------------------- Vorbis comments

function readVorbisComments(bytes, track) {
  let pos = 0;
  const vendorLen = le32(bytes, pos); pos += 4 + vendorLen;
  if (pos + 4 > bytes.length) return;
  const count = le32(bytes, pos); pos += 4;

  for (let i = 0; i < count && pos + 4 <= bytes.length; i++) {
    const len = le32(bytes, pos); pos += 4;
    if (len < 0 || pos + len > bytes.length) break;
    const entry = UTF8.decode(bytes.subarray(pos, pos + len));
    pos += len;

    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = clean(entry.slice(eq + 1));
    if (!value) continue;

    switch (key) {
      case 'TITLE': track.title ||= value; break;
      case 'ARTIST': track.artist ||= value; break;
      case 'ALBUM': track.album ||= value; break;
      case 'ALBUMARTIST':
      case 'ALBUM ARTIST': track.albumArtist ||= value; break;
      case 'TRACKNUMBER': {
        const [num, total] = value.split('/');
        track.track ||= clean(num);
        if (total) track.trackTotal ||= clean(total);
        break;
      }
      case 'TRACKTOTAL':
      case 'TOTALTRACKS': track.trackTotal ||= value; break;
      case 'DATE':
      case 'YEAR': track.year ||= value.slice(0, 4); break;
      case 'GENRE': track.genre ||= value; break;
      case 'METADATA_BLOCK_PICTURE': {
        if (!track.cover) {
          try {
            const raw = base64ToBytes(value);
            track.cover = parseFlacPicture(raw);
          } catch { /* a malformed picture block should not sink the file */ }
        }
        break;
      }
    }
  }
}

function base64ToBytes(text) {
  const binary = typeof atob === 'function'
    ? atob(text)
    : Buffer.from(text, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function parseFlacPicture(block) {
  let pos = 4; // picture type
  const mimeLen = be32(block, pos); pos += 4;
  const mime = ascii(block, pos, mimeLen); pos += mimeLen;
  const descLen = be32(block, pos); pos += 4 + descLen;
  pos += 16; // width, height, depth, colour count
  const dataLen = be32(block, pos); pos += 4;
  return { mime: mime || 'image/jpeg', bytes: block.slice(pos, pos + dataLen) };
}

// ---------------------------------------------------------------- FLAC

export function readFlac(bytes) {
  const track = emptyTrack();
  track.container = 'flac';
  let pos = 4;

  while (pos + 4 <= bytes.length) {
    const header = bytes[pos];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = be24(bytes, pos + 1);
    const body = bytes.subarray(pos + 4, pos + 4 + length);
    if (body.length < length) break;

    if (type === 0 && length >= 34) {
      // 20 bits sample rate, 3 bits channels-1, 5 bits depth-1, 36 bits samples
      const sampleRate = (body[10] << 12) | (body[11] << 4) | (body[12] >> 4);
      const channels = ((body[12] >> 1) & 0x07) + 1;
      const totalSamples =
        ((body[13] & 0x0f) * 2 ** 32) + (be32(body, 14) >>> 0);
      track.sampleRate = sampleRate;
      track.channels = channels;
      if (sampleRate > 0) track.duration = totalSamples / sampleRate;
    } else if (type === 4) {
      readVorbisComments(body, track);
    } else if (type === 6 && !track.cover) {
      try { track.cover = parseFlacPicture(body); } catch { /* ignore */ }
    }

    pos += 4 + length;
    if (isLast) break;
  }

  if (track.duration > 0) {
    track.bitrate = Math.round((bytes.length * 8) / track.duration);
  }
  return track;
}

// ---------------------------------------------------------------- Ogg

/**
 * 64-bit little-endian granule position at page offset +6.
 * A page holding no completed packet stores all 1s; treat that as zero.
 */
function readGranule(bytes, pageStart) {
  const lo = BigInt(le32(bytes, pageStart + 6));
  const hi = BigInt(le32(bytes, pageStart + 10));
  const value = lo | (hi << 32n);
  if (value === 0xffffffffffffffffn) return 0;
  return Number(value);
}

function* oggPages(bytes) {
  let pos = 0;
  while (pos + 27 <= bytes.length) {
    if (ascii(bytes, pos, 4) !== 'OggS') { pos++; continue; }
    const segCount = bytes[pos + 26];
    const tableEnd = pos + 27 + segCount;
    if (tableEnd > bytes.length) break;
    let payloadLen = 0;
    for (let i = 0; i < segCount; i++) payloadLen += bytes[tableEnd - segCount + i];
    // Page header: "OggS"(4) version(1) type(1) granule(8, LE) serial(4) ...
    const granule = readGranule(bytes, pos);
    yield { granule, payload: bytes.subarray(tableEnd, tableEnd + payloadLen) };
    pos = tableEnd + payloadLen;
  }
}

export function readOgg(bytes) {
  const track = emptyTrack();
  track.container = 'ogg';
  let rate = 0;
  let preSkip = 0;
  let lastGranule = 0;
  let seen = 0;

  for (const page of oggPages(bytes)) {
    if (page.granule > lastGranule) lastGranule = page.granule;
    const p = page.payload;
    seen++;

    if (p.length >= 8 && ascii(p, 0, 8) === 'OpusHead') {
      track.container = 'opus';
      track.channels = p[9];
      preSkip = le16(p, 10);
      rate = 48000; // Opus granule positions are always at 48 kHz
      track.sampleRate = le32(p, 12) || 48000;
    } else if (p.length >= 7 && p[0] === 0x01 && ascii(p, 1, 6) === 'vorbis') {
      track.container = 'vorbis';
      track.channels = p[11];
      rate = le32(p, 12);
      track.sampleRate = rate;
    } else if (p.length >= 8 && ascii(p, 0, 8) === 'OpusTags') {
      readVorbisComments(p.subarray(8), track);
    } else if (p.length >= 7 && p[0] === 0x03 && ascii(p, 1, 6) === 'vorbis') {
      readVorbisComments(p.subarray(7), track);
    }

    // Tag data lives in the first few pages; keep scanning only for granule.
    if (seen > 24 && rate) break;
  }

  // The final page's granule gives total length; scan backwards to find it.
  for (let i = bytes.length - 27; i >= 0; i--) {
    if (ascii(bytes, i, 4) === 'OggS') {
      const g = readGranule(bytes, i);
      if (g > lastGranule) lastGranule = g;
      break;
    }
  }

  if (rate > 0 && lastGranule > 0) {
    track.duration = Math.max(0, (lastGranule - preSkip) / rate);
    track.bitrate = Math.round((bytes.length * 8) / track.duration);
  }
  return track;
}

// ---------------------------------------------------------------- MP4 / M4A

const MP4_TEXT = {
  '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album',
  aART: 'albumArtist', '\xa9day': 'year', '\xa9gen': 'genre',
};

export function readMp4(bytes) {
  const track = emptyTrack();
  track.container = 'mp4';

  function visit(name, start, end) {
    if (name === 'mvhd') {
      const version = bytes[start];
      if (version === 1) {
        const timescale = be32(bytes, start + 20);
        const hi = be32(bytes, start + 24);
        const lo = be32(bytes, start + 28);
        if (timescale) track.duration = (hi * 2 ** 32 + lo) / timescale;
      } else {
        const timescale = be32(bytes, start + 12);
        const duration = be32(bytes, start + 16);
        if (timescale) track.duration = duration / timescale;
      }
      return false;
    }
    if (name === 'mdhd' && !track.sampleRate) {
      const version = bytes[start];
      track.sampleRate = version === 1 ? be32(bytes, start + 20) : be32(bytes, start + 12);
      return false;
    }
    if (name === 'ilst') {
      readIlst(bytes, start, end, track);
      return false;
    }
    if (name === 'meta') {
      // `meta` carries 4 bytes of version/flags before its children.
      walkAtoms(bytes, start + 4, end, visit);
      return false;
    }
    return ['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl'].includes(name);
  }

  walkAtoms(bytes, 0, bytes.length, visit);

  if (bytes.length && track.duration > 0) {
    track.bitrate = Math.round((bytes.length * 8) / track.duration);
  }
  track.channels ||= 2;
  return track;
}

function walkAtoms(bytes, start, end, visit) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = be32(bytes, pos);
    const name = ascii(bytes, pos + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit size; the high word is effectively always 0 for our files.
      size = be32(bytes, pos + 12);
      headerSize = 16;
    }
    if (size === 0) size = end - pos;
    if (size < headerSize || pos + size > end) break;

    const bodyStart = pos + headerSize;
    const bodyEnd = pos + size;
    const descend = visit(name, bodyStart, bodyEnd);
    if (descend) walkAtoms(bytes, bodyStart, bodyEnd, visit);
    pos += size;
  }
}

function readIlst(bytes, start, end, track) {
  walkAtoms(bytes, start, end, (name, itemStart, itemEnd) => {
    walkAtoms(bytes, itemStart, itemEnd, (child, dataStart, dataEnd) => {
      if (child !== 'data') return false;
      const type = be32(bytes, dataStart) & 0x00ffffff;
      const payload = bytes.subarray(dataStart + 8, dataEnd);

      if (name === 'covr' && !track.cover) {
        const mime = type === 14 ? 'image/png' : 'image/jpeg';
        track.cover = { mime, bytes: payload.slice() };
        return false;
      }
      if (name === 'trkn' && payload.length >= 6) {
        track.track ||= String(be16(payload, 2));
        const total = be16(payload, 4);
        if (total) track.trackTotal ||= String(total);
        return false;
      }
      if (name === 'gnre' && payload.length >= 2) {
        track.genre ||= ID3_GENRES[be16(payload, 0) - 1] || '';
        return false;
      }
      const field = MP4_TEXT[name];
      if (field && (type === 1 || type === 0)) {
        const value = clean(UTF8.decode(payload));
        if (field === 'year') track[field] ||= value.slice(0, 4);
        else track[field] ||= value;
      }
      return false;
    });
    return false;
  });
}

// ---------------------------------------------------------------- WAV

const WAV_INFO = {
  INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year',
  IGNR: 'genre', IPRT: 'track', ITRK: 'track',
};

export function readWav(bytes) {
  const track = emptyTrack();
  track.container = 'wav';
  let pos = 12;
  let byteRate = 0;

  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos, 4);
    const size = le32(bytes, pos + 4);
    const body = pos + 8;
    if (size < 0 || body + size > bytes.length + 1) break;

    if (id === 'fmt ' && size >= 16) {
      track.channels = le16(bytes, body + 2);
      track.sampleRate = le32(bytes, body + 4);
      byteRate = le32(bytes, body + 8);
      track.bitrate = byteRate * 8;
    } else if (id === 'data') {
      if (byteRate > 0) track.duration = size / byteRate;
    } else if (id === 'LIST' && ascii(bytes, body, 4) === 'INFO') {
      let ip = body + 4;
      while (ip + 8 <= body + size) {
        const key = ascii(bytes, ip, 4);
        const len = le32(bytes, ip + 4);
        const value = clean(LATIN1.decode(bytes.subarray(ip + 8, ip + 8 + len)));
        const field = WAV_INFO[key];
        if (field && value) {
          if (field === 'track') {
            const [num, total] = value.split('/');
            track.track ||= clean(num);
            if (total) track.trackTotal ||= clean(total);
          } else if (field === 'year') {
            track.year ||= value.slice(0, 4);
          } else {
            track[field] ||= value;
          }
        }
        ip += 8 + len + (len % 2);
      }
    }

    pos = body + size + (size % 2);
  }
  return track;
}

// ---------------------------------------------------------------- entry point

/**
 * @param {Uint8Array} bytes  full file contents
 * @param {string} [filename] used only as a fallback title
 */
export function readMetadata(bytes, filename = '') {
  const kind = sniff(bytes);
  let track;

  try {
    switch (kind) {
      case 'mp3': track = readMp3(bytes); break;
      case 'flac': track = readFlac(bytes); break;
      case 'ogg': track = readOgg(bytes); break;
      case 'mp4': track = readMp4(bytes); break;
      case 'wav': track = readWav(bytes); break;
      default: {
        // Some containers still carry an ID3 tag; try it before giving up.
        const attempt = readId3v2(bytes);
        track = attempt.track;
        track.container = kind;
      }
    }
  } catch (error) {
    track = emptyTrack();
    track.container = kind;
    track.parseError = String(error && error.message ? error.message : error);
  }

  if (!track.title && filename) {
    track.title = filename.replace(/\.[^.]+$/, '');
    track.titleFromFilename = true;
  }
  return track;
}
