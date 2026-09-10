#!/usr/bin/env bash
# Regenerates test/fixtures from scratch using the ffmpeg CLI.
# Requires ffmpeg with libmp3lame, libopus, libvorbis and flac.
#
# Exits 0 without doing anything if ffmpeg is missing, so `npm test` still
# runs — the file-based tests skip themselves when fixtures are absent.
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found on PATH — skipping fixture generation."
  echo "File-based tests will be skipped. Install ffmpeg to run the full suite."
  exit 0
fi

mkdir -p "$(dirname "$0")/fixtures"
cd "$(dirname "$0")/fixtures"

TAGS=(
  -metadata "title=Slow Tide"
  -metadata "artist=Marion Vale"
  -metadata "album=Harbour Lights"
  -metadata "album_artist=Marion Vale"
  -metadata "track=7/12"
  -metadata "date=2019"
  -metadata "genre=Ambient"
)

ffmpeg -v error -f lavfi -i "sine=frequency=440:duration=3.5:sample_rate=44100" \
  -ac 2 -c:a pcm_s16le src.wav -y
ffmpeg -v error -f lavfi -i "color=c=#2C6B52:s=300x300:d=1" -frames:v 1 cover.jpg -y
ffmpeg -v error -f lavfi -i "color=c=#C8811B:s=200x200:d=1" -frames:v 1 cover.png -y

# MP3, constant 320k, ID3v2.3, JPEG cover — the common "high bitrate library" case
ffmpeg -v error -i src.wav -i cover.jpg -map 0:a -map 1:v -c:v copy \
  -c:a libmp3lame -b:a 320k -id3v2_version 3 -disposition:v attached_pic \
  "${TAGS[@]}" -metadata:s:v title="Album cover" mp3_320_art.mp3 -y

# MP3, variable bitrate V0, ID3v2.4, no artwork
ffmpeg -v error -i src.wav -c:a libmp3lame -q:a 0 -id3v2_version 4 \
  "${TAGS[@]}" mp3_v0.mp3 -y

# FLAC with a PNG picture block
ffmpeg -v error -i src.wav -i cover.png -map 0:a -map 1:v -c:v copy \
  -c:a flac -disposition:v attached_pic "${TAGS[@]}" flac_art.flac -y

# AAC in MP4 with a covr atom
ffmpeg -v error -i src.wav -i cover.jpg -map 0:a -map 1:v -c:v copy \
  -c:a aac -b:a 192k -disposition:v attached_pic "${TAGS[@]}" aac_art.m4a -y

ffmpeg -v error -i src.wav -c:a libopus -b:a 160k "${TAGS[@]}" opus.opus -y
ffmpeg -v error -i src.wav -c:a libvorbis -q:a 5 "${TAGS[@]}" vorbis.ogg -y
ffmpeg -v error -i src.wav -c:a pcm_s16le "${TAGS[@]}" wav_tagged.wav -y

# Exercises ID3 UTF-16 text encoding
ffmpeg -v error -i src.wav -c:a libmp3lame -b:a 192k -id3v2_version 3 \
  -metadata "title=Låt № 3 — 東京" -metadata "artist=Ø Ensemble" utf.mp3 -y

echo "fixtures written to $(pwd)"
