/**
 * Output format catalogue.
 *
 * Every codec and every ffmpeg option referenced here was verified present in
 * @ffmpeg/core 0.12.10 (single-threaded build): libopus, libmp3lame, native
 * aac, flac, pcm_s16le, plus the -movflags/-id3v2_version/-compression_level
 * options used below. libfdk_aac is NOT in the build, so AAC uses the native
 * encoder.
 */

/** Formats we can hand to ffmpeg as input. */
export const INPUT_EXTENSIONS = [
  'mp3', 'm4a', 'mp4', 'aac', 'flac', 'wav', 'ogg', 'oga',
  'opus', 'aiff', 'aif', 'wma', 'alac', 'webm', 'mka', 'ape',
];

export const INPUT_ACCEPT = 'audio/*,video/mp4,video/webm,' +
  INPUT_EXTENSIONS.map((e) => '.' + e).join(',');

export const FORMATS = {
  opus: {
    id: 'opus',
    name: 'Opus',
    ext: 'opus',
    mime: 'audio/ogg',
    lossless: false,
    coverArt: false,
    summary: 'The smallest file for a given quality.',
    plays: 'Chrome, Firefox, Edge, Android, VLC, Foobar2000. Not on older iPods or many car heads.',
    qualities: [
      { id: '96', label: '96k', kbps: 96, note: 'Spoken word, background listening' },
      { id: '128', label: '128k', kbps: 128, note: 'Clean for most music' },
      { id: '160', label: '160k', kbps: 160, note: 'Matches 320k MP3 for most ears', suggested: true },
      { id: '192', label: '192k', kbps: 192, note: 'Headroom for dense mixes' },
    ],
    args: (q) => ['-c:a', 'libopus', '-b:a', `${q.kbps}k`, '-vbr', 'on', '-application', 'audio'],
  },

  m4a: {
    id: 'm4a',
    name: 'AAC',
    ext: 'm4a',
    mime: 'audio/mp4',
    lossless: false,
    coverArt: true,
    summary: 'Smaller than MP3, and it plays everywhere.',
    plays: 'iPhone, iPad, Mac, Apple Music, Android, Windows, car stereos, Sonos.',
    qualities: [
      { id: '128', label: '128k', kbps: 128, note: 'Small, fine on earbuds' },
      { id: '192', label: '192k', kbps: 192, note: 'Safe step down from 320k MP3', suggested: true },
      { id: '256', label: '256k', kbps: 256, note: 'Matches an iTunes Store file' },
    ],
    args: (q) => ['-c:a', 'aac', '-b:a', `${q.kbps}k`, '-movflags', '+faststart'],
  },

  mp3: {
    id: 'mp3',
    name: 'MP3',
    ext: 'mp3',
    mime: 'audio/mpeg',
    lossless: false,
    coverArt: true,
    summary: 'Plays on anything with a speaker.',
    plays: 'Every player made in the last 25 years.',
    qualities: [
      { id: 'v4', label: 'V4', kbps: 165, note: 'Variable, around 165k' },
      { id: 'v2', label: 'V2', kbps: 190, note: 'Variable, around 190k', suggested: true },
      { id: 'v0', label: 'V0', kbps: 245, note: 'Variable, around 245k' },
      { id: '320', label: '320k', kbps: 320, note: 'Constant, largest MP3' },
    ],
    args: (q) => {
      const vbr = { v0: '0', v2: '2', v4: '4' }[q.id];
      const rate = vbr ? ['-q:a', vbr] : ['-b:a', `${q.kbps}k`];
      return ['-c:a', 'libmp3lame', ...rate, '-id3v2_version', '3'];
    },
  },

  flac: {
    id: 'flac',
    name: 'FLAC',
    ext: 'flac',
    mime: 'audio/flac',
    lossless: true,
    coverArt: true,
    summary: 'Lossless. Only worth it from a lossless source.',
    plays: 'VLC, Foobar2000, Android, Plex, most hi-fi streamers. Not natively on iOS before 11.',
    qualities: [
      { id: '8', label: 'Level 8', level: 8, note: 'Slowest, smallest', suggested: true },
      { id: '5', label: 'Level 5', level: 5, note: 'Balanced, the usual default' },
      { id: '0', label: 'Level 0', level: 0, note: 'Fastest, largest' },
    ],
    args: (q) => ['-c:a', 'flac', '-compression_level', String(q.level)],
  },

  wav: {
    id: 'wav',
    name: 'WAV',
    ext: 'wav',
    mime: 'audio/wav',
    lossless: true,
    coverArt: false,
    summary: 'Uncompressed. For editing, not for a library.',
    plays: 'Every audio editor and DAW.',
    qualities: [
      { id: '16', label: '16-bit', bits: 16, codec: 'pcm_s16le', suggested: true, note: 'CD depth' },
      { id: '24', label: '24-bit', bits: 24, codec: 'pcm_s24le', note: 'Studio depth' },
    ],
    args: (q) => ['-c:a', q.codec],
  },
};

export const FORMAT_ORDER = ['opus', 'm4a', 'mp3', 'flac', 'wav'];

export const DEFAULT_FORMAT = 'opus';

/** Quality entry marked `suggested` for a format, else the first one. */
export function defaultQuality(formatId) {
  const f = FORMATS[formatId];
  return (f.qualities.find((q) => q.suggested) || f.qualities[0]).id;
}

export function getQuality(formatId, qualityId) {
  const f = FORMATS[formatId];
  return f.qualities.find((q) => q.id === qualityId) || f.qualities[0];
}

/**
 * Projected output size in bytes. Lossy formats are a straight bitrate
 * calculation; lossless formats are a ratio estimate against raw PCM, so they
 * are always shown to the user as approximate.
 */
export function estimateSize(formatId, qualityId, track) {
  const seconds = track.duration;
  if (!seconds || !isFinite(seconds) || seconds <= 0) return null;

  const fmt = FORMATS[formatId];
  const q = getQuality(formatId, qualityId);
  const rate = track.sampleRate || 44100;
  const channels = track.channels || 2;

  if (formatId === 'wav') {
    return Math.round(seconds * rate * channels * (q.bits / 8)) + 44;
  }
  if (formatId === 'flac') {
    // FLAC on a lossy source lands near 55-65% of raw PCM; higher compression
    // levels buy a couple of percent, not more.
    const raw = seconds * rate * channels * 2;
    const ratio = { 0: 0.68, 5: 0.61, 8: 0.58 }[q.level] ?? 0.61;
    return Math.round(raw * ratio);
  }
  const container = formatId === 'm4a' ? 1.02 : 1.005;
  return Math.round((seconds * q.kbps * 1000) / 8 * container);
}

/**
 * Build the ffmpeg argument list for one file.
 *
 * @param {object} o
 * @param {string} o.inputName   filename inside the ffmpeg virtual FS
 * @param {string} o.outputName  filename to write
 * @param {string} o.formatId
 * @param {string} o.qualityId
 * @param {string|null} o.coverName  cover image in the FS, or null
 * @param {object} o.tags        tag values to write (may be empty)
 */
export function buildArgs({ inputName, outputName, formatId, qualityId, coverName, tags }) {
  const fmt = FORMATS[formatId];
  const q = getQuality(formatId, qualityId);
  const withArt = Boolean(coverName) && fmt.coverArt;

  const args = ['-i', inputName];
  if (withArt) args.push('-i', coverName);

  args.push('-map', '0:a:0');
  if (withArt) args.push('-map', '1:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');

  args.push('-map_metadata', '0');
  args.push(...fmt.args(q));

  for (const [key, value] of Object.entries(tags || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      args.push('-metadata', `${key}=${value}`);
    }
  }

  if (withArt && formatId === 'mp3') {
    args.push('-metadata:s:v:0', 'title=Album cover');
    args.push('-metadata:s:v:0', 'comment=Cover (front)');
  }

  args.push('-y', outputName);
  return args;
}

/** Same command with the cover art dropped, used as a retry after a mux error. */
export function buildArgsWithoutArt(opts) {
  return buildArgs({ ...opts, coverName: null });
}
