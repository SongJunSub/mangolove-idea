# MangoLove IDEA — v2 백로그

> MVP v1(Plan 0–5)은 완성·머지됨. 이 문서는 v1에서 **YAGNI로 유예한 항목**과
> **v1을 만들며 새로 드러난 후보**를 모은 forward-looking 백로그다. 계속 진화한다.
>
> 규모: **S** = 한 PR / 며칠 · **M** = 한 플랜(Plan 0–5 급) · **L** = 여러 플랜 / 재설계.
> 의존성은 MVP 기준. 각 항목은 착수 시 `writing-plans`로 정식 플랜화 후 진행한다.

상태: 작성 2026-06-18. v1 완성 기준. 갱신 2026-06-19 — **A1 Monaco diff 뷰어 완료**, **E 설정 UI 완료**, **머지 충돌 해결 UI 완료**, **B PR/CI 패널 완료**.

---

## A. 보기·편집 확장 (가장 빠른 가치)

| 기능 | 규모 | 의존성 | 가치 / 메모 |
|------|:--:|------|------|
| ~~**Monaco diff 뷰어**~~ ✅ **완료** | M | Plan 1 | PR-style diff(브랜치 vs base, merge-base 원본) + Monaco DiffEditor(raw monaco, React.lazy 별도 ~7MB 청크) + Terminal\|Diff 토글. read-only. 계획: docs/plans/2026-06-18-v2-monaco-diff.md. 머지 e9af0dc |
| **xterm 스크롤백 저장·재생** | S | Plan 2 | 재시작 시 이전 터미널 화면을 시각 복원(`@xterm/addon-serialize`, 실험적). b-lite 보완. 작음 |
| ~~**머지 충돌 해결 UI**~~ ✅ **완료** | M | Plan 4 | 진짜 충돌은 머지를 일시정지(MERGE_HEAD 유지, `status:'conflict'`)하고 파일별 ours/theirs/manual + keep/remove(stage 누락)로 해결 → Continue(`commit --no-edit`, 충돌 0일 때만)/Abort. 비충돌 실패는 기존 safe-abort 그대로(Branch-by-Abstraction). stateless ConflictResolver(MERGE_HEAD/status 재계산) + owner() 귀속(단일 MERGE_HEAD 오귀속 방지) + 편집 Monaco(마커 위). 계획: docs/plans/2026-06-18-v2-merge-conflict.md. 머지 대기 |

## B. 외부 연동

| 기능 | 규모 | 의존성 | 가치 / 메모 |
|------|:--:|------|------|
| ~~**PR / CI 패널**~~ ✅ **완료** | M | Plan 1 | 선택한 워크트리 브랜치의 GitHub PR 상태 + CI 체크를 **gh CLI**(keyring 인증, 토큰 비노출)로 read-only 조회. stateless GhStatusReader + 순수 classifyGhStatus/summarizeChecks + GH_STATUS/APP_OPEN_EXTERNAL IPC + useGhStatus 훅 + GhStatusPanel. 8-kind union(no-pr/not-pushed 등 차분한 1급 상태), not-pushed는 gh 미스폰 단락. openExternal은 https github.com만(스킴 검증). 계획: docs/plans/2026-06-18-v2-prci-panel.md. 머지 대기 |
| **브라우저 자동화** | M | Plan 3 | 로컬 서버 기동 후 Playwright로 화면 확인까지 한 화면에서 |

## C. 에이전트·세션 심화 (무겁고 불확실 — 명확한 수요 생길 때)

| 기능 | 규모 | 의존성 | 가치 / 트리거 |
|------|:--:|------|------|
| **실제 턴 감지 (`hasActiveTurn`)** | M | Plan 2 | *드러난 후보.* b-lite가 의도적으로 포기한 것. claude TUI 출력 파싱 → 종료 경고를 "라이브 세션"이 아닌 "실행 중인 턴" 기준으로 정밀화. **b-full의 전제** |
| **세션 영속화 b-full** | L | Plan 2, 턴 감지 | 앱을 꺼도 `claude` 프로세스 생존 + 재attach (tmux/abduco 래퍼, 데몬 X). ⚠️ **트리거: "실행 중이던 턴 끊김 절대 불가"가 하드 요구일 때만.** 리서치 결론상 그 전엔 b-lite로 충분 |
| **멀티모델 팬아웃** | L | Plan 2 | 한 작업을 여러 모델/에이전트에 병렬로 던지고 비교. 가장 큰 기능 — 별도 설계 권장 |
| **크로스머신 세션 이동** | L | b-full | 다른 머신에서 세션 이어가기. 로컬 도구 범위를 가장 벗어남 |

## D. 인프라

| 기능 | 규모 | 의존성 | 가치 / 메모 |
|------|:--:|------|------|
| **병렬 서버 (포트/DB 격리)** | L | Plan 3 | MVP가 "서버 한 번에 하나"로 의도적으로 피한 가장 어려운 부분. 포트/DB/미들웨어 격리 |

## E. 앱 기반 (v1을 만들며 드러난 정비 후보)

| 기능 | 규모 | 의존성 | 가치 / 메모 |
|------|:--:|------|------|
| ~~**설정 UI**~~ ✅ **완료** | M | — | agent / verify / server 명령 + base 브랜치를 기어(⚙) 모달에서 편집·영속화. `SettingsStore`(temp+rename, sanitize, corrupt-safe) + 우선순위 **settings > env > default**(`resolveCommands`) → env seam(`MANGO_AGENT_CMD` · `MANGO_VERIFY_CMD` · `MANGO_SERVER_CMD`) 스모크 유지. live-apply: stateless `mergeRunner`/`diffViewer`는 항상 캐시 클리어, 라이브 자식을 가진 `sessionManager`/`serverManager`는 idle일 때만(고아 방지). 계획: docs/plans/2026-06-18-v2-settings.md |
| **멀티레포 / 멀티윈도우** | L | — | 지금은 단일 레포(`process.cwd()`). 여러 레포를 열기 |
| **패키징·배포 (electron-builder)** | M | — | 지금은 `npm run dev` 실행. 서명된 설치본. `electron-builder`는 dev dep로 이미 잡아둠 |

---

## 🎯 권장 진행 순서

1. **Monaco diff** (M, 독립, 의존성 준비됨) — v2 첫 타자로 가장 자연스러움
2. **xterm 스크롤백 재생** (S) 또는 **설정 UI** (M) — 작고 체감 큼
3. **PR/CI 패널** / **머지 충돌 UI** — MVP 워크플로 직결
4. **턴 감지 → b-full** · **멀티모델 팬아웃** · **병렬 서버** — 무겁고 재설계 필요, 명확한 수요 후

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

## Scrollback replay — reset-before-live drain-gate (design note, 2026-06-19)

- **The race the latch alone did not cover:** `term.write(saved)` (the replay, up to 256 KB)
  parses ASYNCHRONOUSLY through xterm's WriteBuffer; a write taking >12 ms yields via setTimeout,
  leaving the remainder of `saved` QUEUED. `term.reset()` clears the screen but does NOT clear
  that write queue, so a live byte arriving mid-replay would sequence as
  [stale queued `saved`] → reset → [live] → [stale `saved` remainder repaints over the live
  `--continue` redraw] = exactly the double-render this feature exists to avoid. In practice the
  ~0.5–2 s spawn→first-output gap almost always drains the replay first (and the data is a
  disposable placeholder, so no data loss), but the `liveStarted` latch alone did not GUARANTEE
  the invariant the plan/JSDoc assert.
- **Fix shipped (`agent-terminal.tsx`):** the reset is now gated on the replay write's COMPLETION
  callback (`term.write(saved, () => { replayDrained = true; ... })`). On the first live byte we
  latch immediately (so a late replay no-ops) and accumulate live chunks IN ORDER into
  `pendingLive`; the reset-before-live runs ONLY once the replay queue is drained (immediately if
  it already drained or no replay was issued, otherwise deferred into the replay's completion
  callback). Because reset() then lands strictly after the last replay byte is parsed and live
  output is written strictly after the reset, no stale `saved` remainder can survive the reset —
  the zero-overlap guarantee now holds even in the rare race, not just the common case.
- **Residual / deferred:** the drain-gate parks live output (in memory, in order) only for the
  brief window until the replay drains; if the replay write never completes (e.g. an in-band
  async parser handler stalls — not used here) the parked chunks would wait on it. xterm fires the
  write callback on normal drain, so this is theoretical. The reset-before-live latch + drain-gate
  are still covered only by typecheck + the manual smoke (no RTL/jsdom test for the timing); adding
  `@testing-library/react` would let us unit-test "reset() called exactly once, after the replay
  callback, with pendingLive flushed in order".
