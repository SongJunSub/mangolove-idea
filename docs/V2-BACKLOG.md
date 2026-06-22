# MangoLove IDEA — v2 백로그

> MVP v1(Plan 0–5)은 완성·머지됨. 이 문서는 v1에서 **YAGNI로 유예한 항목**과
> **v1을 만들며 새로 드러난 후보**를 모은 forward-looking 백로그다. 계속 진화한다.
>
> 규모: **S** = 한 PR / 며칠 · **M** = 한 플랜(Plan 0–5 급) · **L** = 여러 플랜 / 재설계.
> 의존성은 MVP 기준. 각 항목은 착수 시 `writing-plans`로 정식 플랜화 후 진행한다.

상태: 작성 2026-06-18. v1 완성 기준. 갱신 2026-06-19 — **A1 Monaco diff 뷰어 완료**, **E 설정 UI 완료**, **머지 충돌 해결 UI 완료**, **B PR/CI 패널 완료**, **xterm 스크롤백 재생 완료**, **패키징·배포 완료**, **임베디드 브라우저 뷰 완료**, **턴 감지(`hasActiveTurn`) 완료**.

---

## A. 보기·편집 확장 (가장 빠른 가치)

| 기능 | 규모 | 의존성 | 가치 / 메모 |
|------|:--:|------|------|
| ~~**Monaco diff 뷰어**~~ ✅ **완료** | M | Plan 1 | PR-style diff(브랜치 vs base, merge-base 원본) + Monaco DiffEditor(raw monaco, React.lazy 별도 ~7MB 청크) + Terminal\|Diff 토글. read-only. 계획: docs/plans/2026-06-18-v2-monaco-diff.md. 머지 e9af0dc |
| ~~**xterm 스크롤백 저장·재생**~~ ✅ **완료** | S | Plan 2 | reset-before-live 재생: 마운트 시 직전 직렬화 화면을 즉시 복원(갭 필러) → 첫 라이브 바이트에 `term.reset()` 1회 후 `--continue` 라이브로 교체(중복/garble 0). `ScrollbackStore`(per-worktree, temp+rename, corrupt-safe, 256 KB tail-cap) + SCROLLBACK_GET/SET 4-layer IPC + `SerializeAddon`(`@xterm/addon-serialize@0.14.0`). 계획: docs/plans/2026-06-19-v2-xterm-scrollback.md |
| ~~**머지 충돌 해결 UI**~~ ✅ **완료** | M | Plan 4 | 진짜 충돌은 머지를 일시정지(MERGE_HEAD 유지, `status:'conflict'`)하고 파일별 ours/theirs/manual + keep/remove(stage 누락)로 해결 → Continue(`commit --no-edit`, 충돌 0일 때만)/Abort. 비충돌 실패는 기존 safe-abort 그대로(Branch-by-Abstraction). stateless ConflictResolver(MERGE_HEAD/status 재계산) + owner() 귀속(단일 MERGE_HEAD 오귀속 방지) + 편집 Monaco(마커 위). 계획: docs/plans/2026-06-18-v2-merge-conflict.md. 머지 대기 |

## B. 외부 연동

| 기능 | 규모 | 의존성 | 가치 / 메모 |
|------|:--:|------|------|
| ~~**PR / CI 패널**~~ ✅ **완료** | M | Plan 1 | 선택한 워크트리 브랜치의 GitHub PR 상태 + CI 체크를 **gh CLI**(keyring 인증, 토큰 비노출)로 read-only 조회. stateless GhStatusReader + 순수 classifyGhStatus/summarizeChecks + GH_STATUS/APP_OPEN_EXTERNAL IPC + useGhStatus 훅 + GhStatusPanel. 8-kind union(no-pr/not-pushed 등 차분한 1급 상태), not-pushed는 gh 미스폰 단락. openExternal은 https github.com만(스킴 검증). 계획: docs/plans/2026-06-18-v2-prci-panel.md. 머지 대기 |
| ~~**브라우저 자동화 → 임베디드 브라우저 뷰**~~ ✅ **완료(MVP)** | S | Plan 3 | 로컬 dev 서버를 **앱 안에서** 라이브로 본다. Electron 네이티브 `<webview>`(Playwright·크로미움 다운로드 없음 — Electron이 곧 Chromium). `webviewTag:true`(메인 1줄) + 순수 `detectServerUrl`(서버 로그에서 마지막 localhost URL, TDD) + `BrowserPane`(URL 바·`<webview>`·Reload, `partition="persist:mango-browser"`, nodeIntegration off) + `'browser'` paneMode/`tab-browser`. 게스트는 자체 WebContents(contextIsolation on)라 host CSP/IPC와 격리. 신규 IPC 없음. 계획: docs/plans/2026-06-19-v2-browser-view.md |

## C. 에이전트·세션 심화 (무겁고 불확실 — 명확한 수요 생길 때)

| 기능 | 규모 | 의존성 | 가치 / 트리거 |
|------|:--:|------|------|
| ~~**실제 턴 감지 (`hasActiveTurn`)**~~ ✅ **완료** | M | Plan 2 | 종료 경고를 "라이브 세션"이 아닌 **"실행 중인 턴"** 기준으로 정밀화. 접근: **출력 활동 휴리스틱**(claude TUI 문자열 파싱 X — 버전 취약) — PTY가 최근 `ACTIVE_TURN_MS`(1500ms) 내 출력했으면 턴 진행 중. `SessionManager.lastOutputAt`(주입 clock 스탬프) + `hasActiveTurn`/`activeTurnWorktreeIds`. 경고 트리거만 `liveWorktreeIds`→`activeTurnWorktreeIds`로 교체(idle 라이브 세션은 `--continue`로 무손실). kill-sweep는 그대로 `killAll()`(idle 포함 전부). 신규 IPC/매니저 0. **b-full의 전제**. 계획: docs/plans/2026-06-19-v2-turn-detection.md |
| **세션 영속화 b-full** | L | Plan 2, 턴 감지 | 앱을 꺼도 `claude` 프로세스 생존 + 재attach (tmux/abduco 래퍼, 데몬 X). ⚠️ **트리거: "실행 중이던 턴 끊김 절대 불가"가 하드 요구일 때만.** 리서치 결론상 그 전엔 b-lite로 충분 |
| ~~**멀티모델 팬아웃**~~ ✅ **완료** | L | Plan 2 | 한 프롬프트를 N개 `claude --model` 레인(opus/sonnet/haiku, 최대 4)에 병렬로 던진다. 각 레인 = 베이스에서 분기한 새 워크트리(`WorktreeManager` 재사용) + 헤드리스 `claude -p "<prompt>" --permission-mode acceptEdits --model <tier>`(run-to-completion `child_process`, gh-status-reader 미러; PTY 아님). 레인별 diff는 기존 `DIFF_*`/`DiffView` 재사용, 승자 머지는 `MergeRunner`(safe-abort/conflict 그대로). `FanoutManager`(주입형, 단일 활성 런, 동시성 4 캡) + `runLane`/`slugModel`/`buildLaneArgs` 순수 헬퍼(페이크 러너 TDD) + `FANOUT_START/GET/SELECT/ABORT`+`FANOUT_STATUS` 4-layer IPC + `useFanout`/`FanoutView`(프롬프트+모델 피커+레인 카드+레인별 DiffView+select/abort). `skipPermissions`(기본 off, `--dangerously-skip-permissions`) 경고 토글. 계획: docs/plans/2026-06-22-v2-multimodel-fanout.md |
| **크로스머신 세션 이동** | L | b-full | 다른 머신에서 세션 이어가기. 로컬 도구 범위를 가장 벗어남 |

## D. 인프라

| 기능 | 규모 | 의존성 | 가치 / 메모 |
|------|:--:|------|------|
| ~~**병렬 서버 (per-worktree 동시 서버)**~~ ✅ **완료(MVP)** | L | Plan 3 | 워크트리마다 자기 dev 서버를 동시 실행. ServerManager를 SessionManager 모델로 수렴(Map<worktreeId, RunningServer>, scoped replace + identity guard, killAll/dispose 전부 순회, LAST-live onIdle), LogStore를 per-worktree 파티션(Map, 5000줄 ring 각), LogLine.worktreeId 키스톤으로 snapshot/onLine/detect/렌더 리스트 demux. 포트/DB 격리는 미적용 — dev 서버 auto-increment(Vite 5173→5174)에 의존, per-worktree 로그 감지가 실제 포트 픽업(D4 한계: auto-increment 안 하는 러너는 사용자 지정 PORT 필요). 계획: docs/plans/2026-06-22-v2-parallel-servers.md |

## E. 앱 기반 (v1을 만들며 드러난 정비 후보)

| 기능 | 규모 | 의존성 | 가치 / 메모 |
|------|:--:|------|------|
| ~~**설정 UI**~~ ✅ **완료** | M | — | agent / verify / server 명령 + base 브랜치를 기어(⚙) 모달에서 편집·영속화. `SettingsStore`(temp+rename, sanitize, corrupt-safe) + 우선순위 **settings > env > default**(`resolveCommands`) → env seam(`MANGO_AGENT_CMD` · `MANGO_VERIFY_CMD` · `MANGO_SERVER_CMD`) 스모크 유지. live-apply: stateless `mergeRunner`/`diffViewer`는 항상 캐시 클리어, 라이브 자식을 가진 `sessionManager`/`serverManager`는 idle일 때만(고아 방지). 계획: docs/plans/2026-06-18-v2-settings.md |
| **멀티레포 / 멀티윈도우** | L | — | 지금은 단일 레포(`process.cwd()`). 여러 레포를 열기 |
| ~~**패키징·배포 (electron-builder)**~~ ✅ **완료** | M | — | electron-builder@26.15.3로 mac arm64 dmg 패키징. node-pty `build/Release/*`(pty.node + spawn-helper) asarUnpack, `npmRebuild:false`(ABI-146는 electron-rebuild postinstall 산출), ad-hoc 서명(`mac.identity:null`). Finder 런치 PATH 픽스(packaged darwin: `$SHELL -ilc`로 로그인 셸 PATH 머지 → claude/gh/git/npm 스폰) + repo-root 피커(`resolveRepoRoot`: persisted SettingsStore.repoRoot → cwd → null, REPO_GET/PICK IPC, dialog→검증→persist→relaunch). 계획: docs/plans/2026-06-19-v2-packaging.md |

---

## 🎯 권장 진행 순서

1. **Monaco diff** (M, 독립, 의존성 준비됨) — v2 첫 타자로 가장 자연스러움
2. **xterm 스크롤백 재생** (S) 또는 **설정 UI** (M) — 작고 체감 큼
3. **PR/CI 패널** / **머지 충돌 UI** — MVP 워크플로 직결
4. **턴 감지 → b-full** · ~~**멀티모델 팬아웃**~~(완료) · ~~**병렬 서버**~~(완료) — 무겁고 재설계 필요, 명확한 수요 후

## 보류 트리거 (언제 무거운 것을 꺼내나)

- **b-full**: "에이전트가 실행 중이던 턴이 끊기면 절대 안 됨"이 하드 요구가 될 때. 그 전엔 b-lite(`claude --continue`)로 충분.
- **병렬 서버**: 한 번에 둘 이상의 서버를 동시에 띄워야 하는 실제 워크플로가 반복될 때.
- **크로스머신 이동**: 단일 머신 가정이 깨질 때(원격/팀 공유).

---

# V2 Backlog — Merge Conflict Resolution (deferred)

- 3-way merge editor (base/ours/theirs/result). Deferred: monaco 0.55.1 ships no
  merge editor; a hand-built 3-pane is large effort. Single-editor-over-markers ships first.
- Syntax highlighting in the conflict editor (per-language workers). Deferred: would
  pull the heavy ts/json/css/html workers; MVP stays plaintext (editor.worker only).
- Conflict-marker lint: warn if `<<<<<<<`/`=======`/`>>>>>>>` remain when staging a
  manual resolution (git itself does not check). Nice-to-have.
- Inline decorations/gutter actions on each conflict hunk (accept-this-hunk).
- rename/rename and content+rename combined conflicts: richer than keep/remove.
- A dedicated merge:status push event so the conflict pane updates without polling.

---

## PR/CI panel — deferred (post-MVP)

- **Live updates / polling:** add a GH_STATUS_CHANGED event + on-focus or interval polling
  (30–60s while an open-pr is selected) for live CI. Deferred: burns the separate GraphQL
  rate-limit pool (5000/hr) over a long IDE session; pull-only (on-select + manual refresh)
  is enough for MVP and the no-PR common case rarely needs live updates.
- **Richer per-check list:** expose the per-check rows (name/bucket/link) in an expandable
  sub-panel instead of the collapsed passing/failing/pending summary.
- **mergeable / mergeStateStatus:** intentionally OMITTED in MVP (transient UNKNOWN trap +
  meaningless on MERGED/CLOSED). Add behind a "computing…" state with re-poll if surfaced.
- **`git ls-remote` disambiguation:** distinguish "pushed but no PR" from "not pushed" more
  precisely than the @{u} upstream check (no API quota cost).

---

# V2 Backlog — Scrollback replay (deferred ideas, 2026-06-19)

- **Merge-runner cleanup of scrollback:** `merge-runner.ts#cleanupWorktree` removes worktrees
  directly (not via the WORKTREE_REMOVE IPC handler), so it does NOT drop the scrollback entry.
  Backstopped by the per-entry 256 KB cap. Revisit if scrollback.json growth is ever observed.
- **Per-worktree last-access pruning / global cap:** today only a PER-ENTRY byte cap exists.
  Could add a global entry-count LRU cap if a user accumulates very many worktrees over time.
- **Configurable scrollback line bound:** `SERIALIZE_SCROLLBACK_LINES` (1000) and
  `PERSIST_THROTTLE_MS` (1500) are constants. Could surface in Settings (V2 E) if needed.
- **flush-on-quit:** the before-quit sweep kills PTYs but does not force a final serialize of
  every open terminal (the unmount cleanup covers worktree switches; a hard quit relies on the
  last throttled persist, ≤1.5 s stale). Acceptable; revisit if users want pixel-exact restore.
- **RTL component test:** `@testing-library/react` is absent; the reset-before-live latch +
  throttle are covered only by typecheck + the manual smoke. Adding RTL + jsdom would let us
  unit-test the latch (mock window.mango.scrollback + session.onOutput, assert term.reset()
  called exactly once on the first output).
