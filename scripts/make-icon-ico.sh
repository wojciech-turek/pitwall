#!/bin/sh
# Regenerates build/icon.ico, the Windows app and installer icon, from build/icon.png: one image per size Windows
# uses (16-256 px). The macOS icon's transparent margin is cropped off, so the small sizes stay legible.
# Needs ImageMagick 7 (`brew install imagemagick`). Run from the repository root after changing the icon.
set -eu
magick build/icon.png -crop 896x896+64+64 +repage \
  -define icon:auto-resize=256,128,64,48,40,32,24,20,16 build/icon.ico
magick identify build/icon.ico
