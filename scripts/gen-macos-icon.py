#!/usr/bin/env python3
# One-off asset generator (not part of the build - run manually, like
# gen-tray-icons.js's placeholder assets). Requires Python + Pillow
# (`pip install pillow`), unlike gen-tray-icons.js's dependency-free approach
# - anti-aliased rounded-rect masking by hand in raw Node/zlib would be
# disproportionate effort for a one-time asset.
#
# Gives the flat-square Recall logo mark (src/assets/asymbl-icon.png, used
# as-is for the in-app header logo, where a flat square is correct) the
# standard macOS Big Sur+ "squircle" app-icon treatment (rounded shape +
# transparent padding) for use as the Dock icon / .icns source. Real bug
# found via a live screenshot (2026-07-23): both the dev-mode dock icon and
# the packaged asymbl.icns were built from the flat square asset, which
# renders as a hard-edged square next to every other app's rounded icon.
#
# After running this, regenerate asymbl.icns from the output (repo root):
#   D=/tmp/asymbl.iconset && mkdir -p "$D"
#   SRC=src/assets/asymbl-icon-macos.png
#   sips -z 16 16 "$SRC" --out "$D/icon_16x16.png"
#   sips -z 32 32 "$SRC" --out "$D/icon_16x16@2x.png"
#   sips -z 32 32 "$SRC" --out "$D/icon_32x32.png"
#   sips -z 64 64 "$SRC" --out "$D/icon_32x32@2x.png"
#   sips -z 128 128 "$SRC" --out "$D/icon_128x128.png"
#   sips -z 256 256 "$SRC" --out "$D/icon_128x128@2x.png"
#   sips -z 256 256 "$SRC" --out "$D/icon_256x256.png"
#   sips -z 512 512 "$SRC" --out "$D/icon_256x256@2x.png"
#   sips -z 512 512 "$SRC" --out "$D/icon_512x512.png"
#   cp "$SRC" "$D/icon_512x512@2x.png"
#   iconutil -c icns "$D" -o asymbl.icns
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "assets" / "asymbl-icon.png"
OUT = ROOT / "src" / "assets" / "asymbl-icon-macos.png"

CANVAS = 1024
# Apple's Big Sur icon template: content sits inside a squircle occupying
# roughly 824/1024 (~80.5%) of the canvas, corner radius ~22% of the
# squircle's own size (matches system app icons like Notes/Reminders).
SHAPE = 824
RADIUS = int(SHAPE * 0.22)
OFFSET = (CANVAS - SHAPE) // 2

src = Image.open(SRC).convert("RGBA").resize((SHAPE, SHAPE), Image.LANCZOS)

mask = Image.new("L", (SHAPE, SHAPE), 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle([0, 0, SHAPE - 1, SHAPE - 1], radius=RADIUS, fill=255)

shaped = Image.new("RGBA", (SHAPE, SHAPE), (0, 0, 0, 0))
shaped.paste(src, (0, 0), mask)

canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
canvas.paste(shaped, (OFFSET, OFFSET), shaped)
canvas.save(OUT)
print("wrote", OUT, canvas.size)
