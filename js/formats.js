/**
 * Output format catalogue.
 *
 * Every codec and every ffmpeg option referenced here was verified present in
 * @ffmpeg/core 0.12.10 (single-threaded build): libopus, libmp3lame, native
 * aac, flac, pcm_s16le, plus the -movflags/-id3v2_version/-compression_level
 * options used below. libfdk_aac is NOT in the build, so AAC uses the native
 * encoder.
 *
 * IMPORTANT — Opus and the 48 kHz crash. This exact wasm build cannot encode
 * Opus at 48 kHz ("fullband," the mode that covers the full range of human
 * hearing) at all: every attempt throws a low-level
 * `RuntimeError: memory access out of bounds`, with or without -vbr,
 * -application, metadata mapping, or anything else — confirmed directly by
 * driving the actual ffmpeg-core.wasm binary in Node with a fresh instance
 * per test, not just by reading about it. It's also reported upstream:
 * ffmpegwasm/ffmpeg.wasm#591 and #867. 24 kHz and 16 kHz were both confirmed
 * to work in the same tests.
 *
 * The fix below is `-ar 24000` — the highest confirmed-working rate — but
 * that is a real, audible trade-off, not a technicality: Opus at 24 kHz is
 * "super-wideband," capped at roughly 12 kHz of audio bandwidth by the
 * sample rate itself, regardless of bitrate. Cymbals, upper harmonics, and
 * general "air" above that get cut. This is why AAC, not Opus, is this
 * app's default and flagged recommendation — AAC has no such limit in this
 * build and reliably preserves full bandwidth. Opus is still offered for
 * anyone who wants the smaller file and is fine with that ceiling, with
 * copy below that says so rather than repeating the old "indistinguishable
 * from 320k MP3" claim, which was only ever true for 48 kHz Opus.
 */

/** Formats we can hand to ffmpeg as input. */
export const INPUT_EXTENSIONS = [
  'mp3', 'm4a', 'mp4', 'aac', 'flac', 'wav', 'ogg', 'oga',
  'opus', 'aiff', 'aif', 'wma', 'alac', 'webm', 'mka', 'ape',
];

export const INPUT_ACCEPT = 'audio/*,video/mp4,video/webm,' +
  INPUT_EXTENSIONS.map((e) => '.' + e).join(',');

// The one confirmed-working Opus sample rate below the broken 48 kHz. See
// the file comment above — this is a crash workaround, not a preference.
const OPUS_SAFE_SAMPLE_RATE = 24000;

export const FORMATS = {
  opus: {
    id: 'opus',
    name: 'Opus',
    ext: 'opus',
    mime: 'audio/ogg',
    lossless: false,
    coverArt: false,
    summary: 'Smallest file, but this app caps its treble — see note.',
    plays: 'Chrome, Firefox, Edge, Android, VLC, Foobar2000. Not on older iPods or many car heads.',
    qualities: [
      { id: '96', label: '96k', kbps: 96, note: 'Spoken word, podcasts, background listening' },
      { id: '128', label: '128k', kbps: 128, note: 'Smallest file that still sounds clean' },
      {
        id: '160', label: '160k', kbps: 160, suggested: true,
        note: 'Cymbals and high harmonics are softened — a real limit in this browser encoder, not this bitrate. Choose AAC for full range.',
      },
      { id: '192', label: '192k', kbps: 192, note: 'Most headroom this app\u2019s Opus can use' },
    ],
    args: (q) => [
      '-c:a', 'libopus', '-b:a', `${q.kbps}k`, '-vbr', 'on', '-application', 'audio',
      '-ar', String(OPUS_SAFE_SAMPLE_RATE),
    ],
  },

  m4a: {
    id: 'm4a',
    name: 'AAC',
    ext: 'm4a',
    mime: 'audio/mp4',
    lossless: false,
    coverArt: true,
    summary: 'Full quality, smaller than MP3, plays everywhere.',
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

export const FORMAT_ORDER = ['m4a', 'opus', 'mp3', 'flac', 'wav'];

export const DEFAULT_FORMAT = 'm4a';

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
