#!/usr/bin/env bash
#
# Bump a Homebrew cask's `version` and `sha256` in place.
#
# PURE + DETERMINISTIC + IDEMPOTENT: no network, no git, no clock. The Release workflow
# computes (version, sha256) from the freshly built .dmg and calls this; it is ALSO runnable
# locally for a dry-run before any release. Re-running with the same values is a no-op edit.
#
# The cask's `url` interpolates `#{version}`, so ONLY `version` + `sha256` change per release.
#
# Usage: scripts/bump-homebrew-cask.sh <cask-file> <version> <sha256>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <cask-file> <version> <sha256>" >&2
  exit 2
fi

cask="$1"
version="$2"
sha="$3"

[ -f "$cask" ] || { echo "::error::cask file not found: $cask" >&2; exit 1; }

# Validate inputs BEFORE touching the file — a bad version/sha must never reach the cask.
# version: X.Y.Z with an optional .N / -rc.N style suffix. sha256: exactly 64 lowercase hex.
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$'; then
  echo "::error::invalid version (want X.Y.Z): $version" >&2
  exit 1
fi
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "::error::invalid sha256 (want 64 lowercase hex chars): $sha" >&2
  exit 1
fi

# Edit via a temp file so the sed flavor (BSD on macOS, GNU on the CI ubuntu runner) does not
# matter — no in-place `-i` whose syntax differs across platforms. Copy back with `cat` (not
# `mv`) to preserve the cask file's own inode + permissions.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
sed -E \
  -e "s/^([[:space:]]*)version \"[^\"]*\"/\1version \"${version}\"/" \
  -e "s/^([[:space:]]*)sha256 \"[^\"]*\"/\1sha256 \"${sha}\"/" \
  "$cask" >"$tmp"
cat "$tmp" >"$cask"

# Fail loudly if either line did NOT end up with the requested value — never a silent no-op
# (a cask whose DSL drifted, e.g. `version :latest`, must surface, not pass quietly).
grep -qF "version \"${version}\"" "$cask" || { echo "::error::version line not updated in $cask" >&2; exit 1; }
grep -qF "sha256 \"${sha}\"" "$cask" || { echo "::error::sha256 line not updated in $cask" >&2; exit 1; }

echo "bumped $cask -> version ${version}, sha256 ${sha}"
