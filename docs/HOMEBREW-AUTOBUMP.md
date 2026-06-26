# Homebrew cask auto-bump

When a **stable** `vX.Y.Z` tag is released, the `Release` workflow automatically bumps the
Homebrew cask in the separate **[SongJunSub/homebrew-tap](https://github.com/SongJunSub/homebrew-tap)**
repo (`Casks/mangolove-idea.rb`) to the new `version` + `sha256`. No more hand edits.

## Why a PAT is required (one-time setup)

The bump pushes to a **different repo** than the one running the workflow. A workflow's built-in
`GITHUB_TOKEN` is scoped to its own repo only, so it cannot write to the tap. The cross-repo push
authenticates with a **fine-grained Personal Access Token** stored as the secret
`HOMEBREW_TAP_TOKEN`.

### 1. Create a least-privilege fine-grained PAT

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
Generate new token**:

| Field | Value |
|-------|-------|
| Token name | `mangolove-homebrew-bump` |
| Expiration | your choice (e.g. 1 year — set a calendar reminder to rotate) |
| Resource owner | `SongJunSub` |
| Repository access | **Only select repositories → `SongJunSub/homebrew-tap`** |
| Permissions → Repository → **Contents** | **Read and write** |

That is the *entire* grant: one repo, contents only. Do **not** use a classic PAT (those are
account-wide). Copy the token once — GitHub shows it a single time.

### 2. Store it as a repository secret (token never echoed)

Run this and paste the token at the prompt (it is read from stdin, not shown on screen or in
shell history):

```bash
gh secret set HOMEBREW_TAP_TOKEN --repo SongJunSub/mangolove-idea
```

Verify it exists (value is never printed):

```bash
gh secret list --repo SongJunSub/mangolove-idea | grep HOMEBREW_TAP_TOKEN
```

## How it works

`.github/workflows/release.yml`:

1. The `release` job builds the unsigned arm64 `.dmg`, computes its `sha256` from that exact
   artifact, and publishes the GitHub Release. It exports `version`, `dmg_sha256`, and
   `is_stable` as job outputs (set only on tag pushes).
2. The `bump-homebrew` job runs **only for stable tags** (`is_stable == 'true'`; rc/beta tags
   carry a hyphen and are skipped). It checks out the tap with the PAT, runs
   `scripts/bump-homebrew-cask.sh`, and commits + pushes as `github-actions[bot]`.

The cask `url` interpolates `#{version}`, so only the `version` and `sha256` lines change. The
sha always matches the published file because both come from the same built artifact.

## Manual bump / dry-run

The bump script is pure (no network, no git) and runs anywhere:

```bash
# Dry-run against a copy to preview the edit:
cp <path-to>/mangolove-idea.rb /tmp/cask.rb
scripts/bump-homebrew-cask.sh /tmp/cask.rb 0.2.0 <64-hex-sha256>
diff <path-to>/mangolove-idea.rb /tmp/cask.rb
```

To bump the real tap by hand (e.g. before the PAT exists), edit the cask in a tap clone with the
same script, then commit + push.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `HOMEBREW_TAP_TOKEN is not set` | Secret missing — do step 2 above. |
| `Permission ... denied` on push | PAT lacks **Contents: write** on the tap, expired, or wrong resource owner. Regenerate. |
| Bump job skipped | Tag was a pre-release (has a hyphen) or it was a `workflow_dispatch` run — by design. |
| `version line not updated` | The cask DSL drifted (e.g. no plain `version "..."` line). Update the script's `sed` anchors. |
| Release published but cask not bumped | The bump job is independent; re-run it from the Actions tab, or bump by hand with the script. |
