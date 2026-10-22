#!/usr/bin/env bash
# Builds demo/out/homeops-demo.mp4 from demo/script.json:
#   - card segments: demo/cards/<id>.png with narration (narration/polly/<id>.mp3
#     if present, else narration/draft/<id>.mp3)
#   - clip segments: the Alexa+ simulator recording at demo/<clip> if present,
#     else the placeholder slate demo/cards/<id>.png for placeholderSeconds
# Needs: bash, ffmpeg, ffprobe, python3.   Usage: ./demo/assemble.sh
set -euo pipefail

DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$DEMO/out"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

for cmd in ffmpeg ffprobe python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required command '$cmd' not found." >&2; exit 1; }
done

FPS=30
VENC=(-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r "$FPS")
AENC=(-c:a aac -b:a 160k -ar 48000 -ac 2)
LOUD="loudnorm=I=-16:TP=-1.5:LRA=11"
FIT="scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0E1116,setsar=1,fps=$FPS"

duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
has_audio() { [ -n "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$1")" ]; }
fades() { # video fade filter for a segment of length $1 seconds
  python3 -c "import sys; d=float(sys.argv[1]); print(f'fade=t=in:st=0:d=0.3,fade=t=out:st={max(d-0.35,0):.3f}:d=0.35')" "$1"
}

# id | card png | narration audio | clip file | placeholder seconds
python3 - "$DEMO" > "$WORK/plan.txt" <<'EOF'
import json, sys
from pathlib import Path
demo = Path(sys.argv[1])
for s in json.loads((demo / "script.json").read_text(encoding="utf-8"))["segments"]:
    audio = ""
    for kind in ("polly", "draft"):
        p = demo / "narration" / kind / f"{s['id']}.mp3"
        if s.get("narration") and p.exists():
            audio = str(p)
            break
    clip = str(demo / s["clip"]) if s.get("clip") else ""
    print("|".join([s["id"], str(demo / "cards" / f"{s['id']}.png"), audio, clip, str(s.get("placeholderSeconds", 0))]))
EOF

: > "$WORK/concat.txt"
i=0
while IFS='|' read -r id card audio clip placeholder; do
  i=$((i + 1))
  seg="$WORK/$(printf '%02d' "$i")-$id.mp4"

  if [ -n "$clip" ] && [ -f "$clip" ]; then
    d="$(duration "$clip")"
    if has_audio "$clip"; then
      ffmpeg -nostdin -hide_banner -loglevel error -y -i "$clip" \
        -vf "$FIT,$(fades "$d")" -af "$LOUD,afade=t=in:d=0.2" "${VENC[@]}" "${AENC[@]}" "$seg"
    else
      ffmpeg -nostdin -hide_banner -loglevel error -y -i "$clip" -f lavfi -i anullsrc=r=48000:cl=stereo \
        -vf "$FIT,$(fades "$d")" -shortest "${VENC[@]}" "${AENC[@]}" "$seg"
    fi
    echo "  clip        $id  (${d%.*}s from ${clip#$DEMO/})"
  elif [ -n "$clip" ]; then
    d="$placeholder"
    ffmpeg -nostdin -hide_banner -loglevel error -y -loop 1 -framerate "$FPS" -t "$d" -i "$card" \
      -f lavfi -t "$d" -i anullsrc=r=48000:cl=stereo \
      -vf "$FIT,$(fades "$d")" "${VENC[@]}" "${AENC[@]}" "$seg"
    echo "  PLACEHOLDER $id  (${d}s, record ${clip#$DEMO/})"
  else
    [ -n "$audio" ] || { echo "No narration audio for $id; run demo/tools/narration.py first." >&2; exit 1; }
    d="$(python3 -c "import sys; print(f'{float(sys.argv[1]) + 1.1:.3f}')" "$(duration "$audio")")"
    ffmpeg -nostdin -hide_banner -loglevel error -y -loop 1 -framerate "$FPS" -t "$d" -i "$card" -i "$audio" \
      -vf "$FIT,$(fades "$d")" -af "adelay=450:all=1,$LOUD,apad" -t "$d" "${VENC[@]}" "${AENC[@]}" "$seg"
    echo "  card        $id  (${d%.*}s, ${audio#$DEMO/})"
  fi
  echo "file '$seg'" >> "$WORK/concat.txt"
done < "$WORK/plan.txt"

OUT="$OUT_DIR/homeops-demo.mp4"
ffmpeg -nostdin -hide_banner -loglevel error -y -f concat -safe 0 -i "$WORK/concat.txt" -c copy -movflags +faststart "$OUT"
total="$(duration "$OUT")"
echo "==> $OUT  ($(python3 -c "import sys; t=float(sys.argv[1]); print(f'{int(t//60)}:{t%60:04.1f}')" "$total"))"
python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) <= 178 else 1)" "$total" \
  || echo "WARNING: over 2:58. Devpost requires under 3:00; trim the simulator clips." >&2
if grep -q PLACEHOLDER <(python3 - "$DEMO" <<'EOF'
import json, sys
from pathlib import Path
demo = Path(sys.argv[1])
for s in json.loads((demo / "script.json").read_text())["segments"]:
    if s.get("clip") and not (demo / s["clip"]).exists():
        print("PLACEHOLDER")
EOF
); then
  echo "NOTE: some simulator clips are still placeholders. Don't submit this cut." >&2
fi
