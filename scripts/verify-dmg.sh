#!/bin/sh
# Checks what users download: the app inside the DMG has a valid signature, and the DMG has an Applications link.
set -eu
dmg="${1:?usage: verify-dmg.sh <path to .dmg>}"
mnt=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
trap 'hdiutil detach "$mnt" -quiet || true; rmdir "$mnt" 2>/dev/null || true' EXIT
codesign --verify --deep --strict --verbose=2 "$mnt/Pitwall.app"
[ -L "$mnt/Applications" ] || { echo "No Applications link in $dmg" >&2; exit 1; }
echo "DMG ok: $dmg"
