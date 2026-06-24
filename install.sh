#!/usr/bin/env bash
#
# MangoLove IDEA — one-line macOS installer.
#
#   curl -fsSL https://raw.githubusercontent.com/SongJunSub/mangolove-idea/main/install.sh | bash
#
# Downloads the latest release .dmg, copies the app into /Applications (or
# ~/Applications if /Applications isn't writable — no sudo), and removes the
# Gatekeeper quarantine attribute so the UNSIGNED build opens without the
# "unidentified developer" prompt. The app is not notarized (that needs a paid
# Apple Developer account); stripping quarantine is the standard way to run an
# unsigned app you trust. Every step is printed so a `curl | bash` run is auditable.
#
# Test/offline override: set MANGO_INSTALL_DMG=/path/to/local.dmg to install from a
# local .dmg instead of downloading.

set -euo pipefail

REPO="SongJunSub/mangolove-idea"
APP_NAME="MangoLove IDEA.app"

say() { printf '\033[1;33m==>\033[0m %s\n' "$1"; }
die() {
  printf '\033[1;31m✗\033[0m %s\n' "$1" >&2
  exit 1
}

# --- Preconditions -----------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "macOS 전용입니다."
[ "$(uname -m)" = "arm64" ] || die "Apple Silicon(arm64) 전용 빌드입니다 (현재: $(uname -m))."

# --- Install destination (no sudo): MANGO_INSTALL_DEST override, else prefer
# /Applications, else ~/Applications.
if [ -n "${MANGO_INSTALL_DEST:-}" ]; then
  DEST="$MANGO_INSTALL_DEST"
  mkdir -p "$DEST"
elif [ -w "/Applications" ]; then
  DEST="/Applications"
else
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi

# --- Temp workspace, cleaned up on any exit ----------------------------------------
TMP="$(mktemp -d)"
MNT=""
cleanup() {
  [ -n "$MNT" ] && hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- Resolve the .dmg (local override, else latest GitHub release) ------------------
if [ -n "${MANGO_INSTALL_DMG:-}" ]; then
  [ -f "$MANGO_INSTALL_DMG" ] || die "MANGO_INSTALL_DMG 파일이 없습니다: $MANGO_INSTALL_DMG"
  DMG="$MANGO_INSTALL_DMG"
  say "로컬 dmg 사용: $DMG"
else
  say "최신 릴리즈 조회…"
  api="https://api.github.com/repos/${REPO}/releases/latest"
  # No auth needed for a public repo. Pull the first .dmg asset's download URL.
  dmg_url="$(curl -fsSL "$api" \
    | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.dmg"' \
    | head -1 \
    | sed -E 's/.*"(https[^"]*\.dmg)".*/\1/' || true)"
  [ -n "$dmg_url" ] ||
    die "릴리즈에서 .dmg를 찾지 못했습니다. https://github.com/${REPO}/releases 를 확인하세요."
  say "다운로드: $dmg_url"
  DMG="$TMP/MangoLove.dmg"
  curl -fSL --progress-bar "$dmg_url" -o "$DMG"
fi

# --- Mount (read-only, no Finder window), install, unmount --------------------------
say "마운트…"
MNT="$TMP/mnt"
mkdir -p "$MNT"
hdiutil attach "$DMG" -nobrowse -readonly -quiet -mountpoint "$MNT"

[ -d "$MNT/$APP_NAME" ] || die "dmg 안에서 '$APP_NAME' 을 찾지 못했습니다."

say "설치: $DEST/$APP_NAME"
# Replace any existing copy. :? guards against an empty var ever expanding to rm -rf /.
rm -rf "${DEST:?}/$APP_NAME"
cp -R "$MNT/$APP_NAME" "$DEST/"

hdiutil detach "$MNT" -quiet
MNT=""

# --- Clear Gatekeeper quarantine so the unsigned app opens without a prompt ----------
say "Gatekeeper quarantine 제거 (unsigned 앱이라 필요)…"
xattr -dr com.apple.quarantine "$DEST/$APP_NAME" 2>/dev/null || true

printf '\033[1;32m✓ 설치 완료\033[0m  %s\n' "$DEST/$APP_NAME"
printf '   실행:  open "%s"\n' "$DEST/$APP_NAME"
