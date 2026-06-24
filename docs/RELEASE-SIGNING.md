# Release signing & notarization runbook (macOS, Developer ID)

MangoLove IDEA is distributed **outside the Mac App Store** (Developer ID + Apple
notarization). This runbook is the end-to-end procedure to produce a signed,
notarized, stapled `.dmg` that opens on other Macs without a Gatekeeper warning.

> **Secrets rule:** every credential is supplied via an **environment variable by
> name**. Never paste a secret value into a committed file, a commit message, a PR,
> or this doc. Credential files (`.p8`, `.p12`, `*.signing.env`) are gitignored.

---

## 0. Mental model — what must be true

For a non-App-Store app to launch cleanly on another Mac, **every Mach-O inside the
`.app`** must be:

1. signed with a **Developer ID Application** certificate,
2. built with **hardened runtime**, and
3. carry a **secure timestamp**,

and then the artifact must be **notarized** by Apple and the ticket **stapled**. We
staple **both**:

- the **`.app`** (electron-builder does this via `@electron/notarize` when
  `mac.notarize` is on) — so the app launches offline once extracted to `/Applications`,
- the **`.dmg`** artifact itself (our `afterAllArtifactBuild` hook runs
  `xcrun notarytool submit … --wait` then `xcrun stapler staple` on the dmg) — so the
  downloaded `.dmg` passes Gatekeeper when first **mounted**, offline.

electron-builder notarizes/staples only the `.app`, NOT the `.dmg` (`dmg.sign` defaults
false), which is why the hook exists. If you decide to ship the extracted/zipped `.app`
instead of the `.dmg`, the dmg step is moot (the app is already stapled) and you can drop
the `afterAllArtifactBuild` hook.

This app ships two extra nested Mach-O helpers that are **exec'd** as child processes
(so they each need their own valid signature, not just the app):

- `Contents/Resources/bin/abduco` (extraResources; ships ad-hoc/linker-signed today —
  the build **re-signs** it with Developer ID),
- `Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`
  (and `pty.node`), unpacked via `asarUnpack`.

electron-builder signs every Mach-O it finds inside the bundle (app, framework,
helpers, `extraResources`, `asarUnpack`'d files), so both helpers are covered
automatically — we **verify** that in step 6 rather than trusting it.

---

## 1. One-time setup

### 1.1 Enroll in the Apple Developer Program

Required to obtain a Developer ID certificate and to notarize. Individual or
organization enrollment both work; note your **10-character Team ID** (App Store
Connect → Membership, or `Keychain Access` cert detail "OU=").

### 1.2 Create + install a "Developer ID Application" certificate

Either via Xcode (Settings → Accounts → Manage Certificates → `+` → "Developer ID
Application") or via the Apple Developer portal (Certificates → `+` → "Developer ID
Application", upload a CSR from Keychain Access → Certificate Assistant). Then:

- Double-click the downloaded `.cer` to install it into the **login** keychain.
- Confirm it is present **with its private key**:

```bash
security find-identity -v -p codesigning
```

You must see a line like
`1) ABCDEF... "Developer ID Application: Your Name (TEAMID)"`.
If the cert shows but signing fails later, the **private key** isn't in the keychain
(re-export/re-import a `.p12` that contains the key).

> Until this exists, `security find-identity -v -p codesigning` prints
> `0 valid identities found` (the current state of this machine). The signed build
> cannot run yet — but the **unsigned** build (`npm run dist:dir`) still works.

### 1.3 Notarization credentials — pick ONE path

#### Path B — App Store Connect API key (RECOMMENDED)

App Store Connect → Users and Access → **Integrations / Keys** → App Store Connect
API → generate a key. You get:

- a one-time-download **`AuthKey_XXXXXXXXXX.p8`** — store it **outside the repo**
  (e.g. `~/.appstoreconnect/keys/`), `chmod 600`,
- the **Key ID** (the `XXXXXXXXXX`),
- the **Issuer ID** (a UUID shown on the Keys page).

**Why B is recommended:** no Apple-ID 2FA friction, no app-specific-password rotation,
the key is scoped/revocable independently of your Apple ID, and it carries the Team
context so you don't separately manage `APPLE_TEAM_ID` for notarization. This is the
better fit for CI/automation later.

Maps to env vars (read by electron-builder 26 — verified in
`app-builder-lib/out/mac/MacTargetHelper.js` `getNotarizeOptions`):

| Env var            | Value                                            |
| ------------------ | ------------------------------------------------ |
| `APPLE_API_KEY`    | absolute path to the `.p8` file                  |
| `APPLE_API_KEY_ID` | the Key ID                                        |
| `APPLE_API_ISSUER` | the Issuer ID (UUID)                             |

#### Path A — Apple ID + app-specific password (alternative)

appleid.apple.com → Sign-In and Security → **App-Specific Passwords** → generate one
for "MangoLove notarization". Maps to:

| Env var                       | Value                              |
| ----------------------------- | ---------------------------------- |
| `APPLE_ID`                    | your Apple ID email                |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password          |
| `APPLE_TEAM_ID`               | your 10-char Team ID               |

**Trade-off:** tied to a personal Apple ID, the password must be regenerated if you
change your Apple ID password, and it's awkward to share with CI. Works fine locally.

> electron-builder prefers **Path A if `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` are
> set**, otherwise falls back to **Path B**. Don't set both. If a path is partially
> set (e.g. `APPLE_ID` without the password), the build **errors** with a clear
> "needs to be set" message — by design.

### 1.4 (Optional) Portable certificate via CSC_LINK

If you can't rely on the login keychain (fresh machine, future CI), export the
Developer ID cert **with its private key** as a `.p12` and point electron-builder at
it instead of keychain discovery:

| Env var            | Value                                     |
| ------------------ | ----------------------------------------- |
| `CSC_LINK`         | path to the `.p12` (or a base64 string)   |
| `CSC_KEY_PASSWORD` | the `.p12` export password                |

Keep the `.p12` outside the repo. With these set, electron-builder imports the cert
into a temporary keychain for the build and uses it instead of `security find-identity`.

---

## 2. How signing is OPT-IN (CI & local unsigned stay green)

The package.json `build` block keeps `mac.identity: null`, which **disables signing**.
electron-builder reads that block by default, so:

- `npm run build` (CI), `npm run dist:dir`, and `npm run dist` produce **unsigned**
  output and need **zero** secrets. CI never tries to sign.

The **signed** path lives in a separate, opt-in config:
`electron-builder.signed.cjs`. It:

- is only used when you pass `--config electron-builder.signed.cjs` (the `dist:signed`
  script), and
- **throws unless `MANGO_SIGN=1`**, so an accidental invocation can't silently
  produce a half-signed build.

So signing is gated **twice**: by the explicit `--config` flag AND by `MANGO_SIGN=1`.
Nothing in CI sets either, so CI's `npm run build` stays unsigned and green.

The signed config also sets **`forceCodeSigning: true`** — so if you run `dist:signed`
but no Developer ID identity is found, the build **hard-fails loudly** instead of
silently producing an unsigned app (electron-builder's default for non-MAS is to warn
and continue). And it **throws if both** the Apple-ID and API-key notary env sets are
present (the Apple-ID path would otherwise silently win) — export exactly one path.

---

## 3. The exact command you run locally (with creds in env, by NAME only)

> Put your secrets in a **gitignored** `~/.mangolove/signing.env` (or `.signing.env`
> in the repo — it's gitignored) and `source` it. NEVER echo the values.

Example `~/.mangolove/signing.env` (values are placeholders — fill in your own; this
file is NOT committed):

```sh
# --- notarization: App Store Connect API key (Path B, recommended) ---
export APPLE_API_KEY="$HOME/.appstoreconnect/keys/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"

# --- signing identity (optional pin; omit to auto-discover the keychain cert) ---
# export MANGO_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"

# --- opt-in gate ---
export MANGO_SIGN=1
```

Then build:

```bash
source ~/.mangolove/signing.env          # loads the env vars by name; no values shown
npm run dist:signed                       # build + sign + notarize + staple
```

`dist:signed` is `npm run build && electron-builder --mac --arm64 --config electron-builder.signed.cjs`.

What runs, in order:

1. electron-builder signs **every Mach-O** with Developer ID + hardened runtime + secure
   timestamp (the app, Electron frameworks/helpers, node-pty's `pty.node`/`spawn-helper`,
   and the `abduco` helper — `@electron/osx-sign` walks all of `Contents/` and re-signs
   with `--force`, overwriting abduco's ad-hoc signature),
2. `mac.notarize` runs `notarytool` on the **`.app`** (waits for Apple) and staples it,
3. electron-builder builds the **`.dmg`** around the stapled app,
4. our `afterAllArtifactBuild` hook runs `notarytool submit … --wait` then
   `stapler staple` on the **`.dmg`** itself.

A successful app notarization logs `notarization successful`; the dmg step prints
`[signed] notarizing DMG …`/`[signed] stapling DMG …`. Output lands in `release/`.

---

## 4. Quick pre-flight (before a real notarized build)

```bash
# 1) Identity present (with private key)?
security find-identity -v -p codesigning | grep "Developer ID Application"

# 2) Notary credentials valid? (Path B) — this hits Apple and lists prior submissions.
xcrun notarytool history \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" \
  | head

#    (Path A instead:)
# xcrun notarytool history --apple-id "$APPLE_ID" \
#   --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" | head
```

If `notarytool history` returns without an auth error, your creds are good.

---

## 5. Verify the RESULT (the gate that actually matters)

Run against the produced `.app` (mount the dmg, or use the staged
`release/mac-arm64/MangoLove IDEA.app`). Set `APP` once:

```bash
APP="release/mac-arm64/MangoLove IDEA.app"
```

### 5.1 Code signature is valid, deep, strict

```bash
codesign --verify --deep --strict --verbose=2 "$APP"
# expect: "...: valid on disk" and "...: satisfies its Designated Requirement"
```

### 5.2 Gatekeeper accepts it for INSTALL (notarized + stapled)

```bash
spctl -a -vvv -t install "$APP"
# expect: "accepted", "source=Notarized Developer ID",
#         "origin=Developer ID Application: Your Name (TEAMID)"
```

`source=Notarized Developer ID` is the proof notarization succeeded. If you see
`source=Developer ID` WITHOUT "Notarized", it's signed but not notarized/stapled.

### 5.3 The notarization ticket is stapled

```bash
xcrun stapler validate "$APP"
xcrun stapler validate "release/MangoLove IDEA-0.1.0-arm64.dmg"   # adjust filename
# expect: "The validate action worked!"
```

### 5.4 The app itself carries Developer ID + hardened runtime + timestamp

```bash
codesign -dv --verbose=4 "$APP" 2>&1 | \
  grep -E "Authority|TeamIdentifier|flags|Timestamp|Identifier"
# expect:
#   Authority=Developer ID Application: Your Name (TEAMID)
#   Authority=Developer ID Certification Authority
#   Authority=Apple Root CA
#   TeamIdentifier=TEAMID            (NOT "not set")
#   flags=0x10000(runtime)           (hardened runtime ON)
#   Timestamp=<a real date>          (secure timestamp present, NOT absent)
```

### 5.5 The NESTED helpers are each properly signed (the easy thing to miss)

`abduco` ships ad-hoc today (`TeamIdentifier=not set`, `flags=0x20002(adhoc,
linker-signed)`); after a signed build it MUST show your Team ID + hardened runtime:

```bash
ABDUCO="$APP/Contents/Resources/bin/abduco"
codesign --verify --strict --verbose=2 "$ABDUCO"
codesign -dv --verbose=4 "$ABDUCO" 2>&1 | \
  grep -E "Authority|TeamIdentifier|flags|Timestamp"
# expect: Authority=Developer ID Application...  TeamIdentifier=TEAMID
#         flags=...(runtime)  Timestamp=<real date>   (NO "adhoc")

SPAWN="$APP/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper"
codesign --verify --strict --verbose=2 "$SPAWN"
codesign -dv --verbose=4 "$SPAWN" 2>&1 | grep -E "Authority|TeamIdentifier|flags"
# same expectation: Developer ID + your Team ID + runtime flag.
```

If `abduco` or `spawn-helper` still shows `adhoc` / `TeamIdentifier=not set` after the
build, the bundle will be REJECTED by notarization (or fail to exec on a clean Mac).
That means electron-builder did not re-sign it — re-check that the file is inside the
`.app` and is a Mach-O, and re-run; do not ship.

---

## 6. Final acceptance test (clean-machine equivalent)

The strongest local check that another Mac will accept it: remove the quarantine-free
advantage by asking Gatekeeper directly, then actually launch:

```bash
spctl -a -vvv -t install "$APP" && open "$APP"
```

A correctly notarized + stapled app launches with no "unidentified developer" /
"malicious software" dialog, even offline (the staple is what makes offline work).

---

## 7. Troubleshooting

- **`spctl ... rejected, source=Unnotarized Developer ID`** — signing worked but
  notarization didn't run or didn't staple. Confirm the notary env vars were sourced
  in the SAME shell, and look for `notarization successful` in the build log. If the
  log says `skipped macOS notarization (notarize options were unable to be generated)`,
  no notary creds were present — re-`source` the env file.
- **`The binary is not signed with a valid Developer ID certificate`** (from notary
  log) — a nested Mach-O (likely `abduco`) wasn't re-signed. See 5.5.
- **`code object is not signed at all` on a helper** — it was added after signing, or
  excluded from the bundle scan. Ensure it's under `extraResources`/`asarUnpack`.
- **Notarization is slow** — `notarytool` waits for Apple's service; minutes is normal.
  Use `xcrun notarytool log <submission-id> ...` to read a rejection's details.
- **Wrong cert chosen** (multiple Developer ID certs) — set `MANGO_SIGN_IDENTITY` to
  the exact identity string to pin it.

---

## Appendix — env var reference (names only; never store values in git)

| Env var                       | Purpose                                              | Required when            |
| ----------------------------- | ---------------------------------------------------- | ------------------------ |
| `MANGO_SIGN`                  | Opt-in gate; must be `1` for `dist:signed`           | always (signed build)    |
| `MANGO_SIGN_IDENTITY`         | Pin the exact Developer ID identity (optional)       | multiple certs present   |
| `APPLE_API_KEY`               | Path to App Store Connect API `.p8`                  | notarize Path B          |
| `APPLE_API_KEY_ID`            | App Store Connect Key ID                             | notarize Path B          |
| `APPLE_API_ISSUER`            | App Store Connect Issuer ID (UUID)                   | notarize Path B          |
| `APPLE_ID`                    | Apple ID email                                       | notarize Path A          |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password                                | notarize Path A          |
| `APPLE_TEAM_ID`               | 10-char Team ID                                      | notarize Path A          |
| `CSC_LINK`                    | Path/base64 of Developer ID `.p12` (optional)        | no keychain cert         |
| `CSC_KEY_PASSWORD`            | `.p12` export password                               | with `CSC_LINK`          |
