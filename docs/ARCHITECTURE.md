# MangoLove IDEA — 아키텍처 (as-built)

> 구현된 시스템의 실제 구조. 초기 설계 의도는 [DESIGN.md](DESIGN.md), 기능별 계획은
> [plans/](plans/). 이 문서는 코드 기준 사실을 담는다 — 코드가 바뀌면 같이 갱신한다.

## 프로세스 모델

Electron 3-프로세스 표준 위에 얹은 **순수 코어 + 주입된 이펙트** 패턴.

```
┌─ Main (Node, 엔진) ─────────────────────────────────────────────┐
│  managers · git · pty · sync · proc · util                       │
│  순수 로직 + 생성자 주입 의존성(emitter/clock/git/process)        │
└───────────────┬─────────────────────────────────────────────────┘
                │ IPC  (contextBridge: window.mango)
                │ 라우팅: Map<webContents.id, IpcContext> + requireCtxFrom
┌───────────────┴─ Preload (bridge) ──────────────────────────────┐
│  ipc-contract의 MangoApi를 invoke/subscribe로 노출, raw IPC 차단  │
└───────────────┬─────────────────────────────────────────────────┘
┌───────────────┴─ Renderer (React, GUI) ─────────────────────────┐
│  components(화면) + hooks(IPC 도메인별 상태) + lib(순수 헬퍼)      │
└──────────────────────────────────────────────────────────────────┘
```

핵심 척추: 각 worktree에 **PTY(node-pty) + xterm.js**로 진짜 터미널을 박아 `claude`를
인터랙티브로 실행/렌더링한다.

## Main 프로세스 서브시스템

### `managers/` — 상태 소유자
| 파일 | 역할 |
|---|---|
| `worktree-manager.ts` | `git worktree list --porcelain` 파싱 → 생성/삭제. 브랜치명 새니타이즈(옵션 인젝션·특수 ref 거부), detached-HEAD 머지 차단. |
| `session-manager.ts` | `Map<worktreeId, Session>`(PTY + status + lastOutputAt) 소유. 주입된 PtyFactory/AgentLauncher로 spawn. `hasActiveTurn`(출력 활동 휴리스틱), `liveWorktreeIds()`, `killAll()`. |
| `server-manager.ts` | `Map<worktreeId, RunningServer>` 소유 — worktree마다 동시 서버. 러너 감지(gradlew/npm), `findFreePort`로 distinct PORT 주입(BASE_PORT 5173~), stdout/stderr → LogStore. |
| `log-store.ts` | worktree별 링버퍼(`Map<worktreeId, Partition>`). 청크→라인(부분 라인 보존), 레벨 파싱(ERROR/WARN/INFO/DEBUG), worktree당 상한. |
| `session-store.ts` | `SessionRecord[]`(worktreePath·branch·hadActiveSession·updatedAt) 영속화. 부팅 시 b-lite `--continue` 복원에 사용. |
| `settings-store.ts` | agent/verify/server 명령 + base 브랜치 영속화. 환경변수 seam(`MANGO_*`). idle일 때만 live-apply(busy면 dirty 플래그). |
| `scrollback-store.ts` | worktree별 직렬화된 xterm 화면(ANSI). 엔트리당 256KB, 전역 32-엔트리 LRU. |

> 세 store(session/settings/scrollback)는 **corrupt-safe 원자적 저장**: temp+rename 기록,
> 손상/누락 JSON → 기본값. 영속 대화 상태는 보관하지 않음(Claude가 JSONL로 소유) — 최악도
> "즉시 복원" 1회 누락이지 데이터 손실 아님.

### `git/` — git 작업 (상태 최소)
| 파일 | 역할 |
|---|---|
| `merge-runner.ts` | verify 훅 → 머지(primary tree) → 선택적 정리. 무상태, 단계별 `MERGE_PROGRESS` emit. 비충돌 실패는 safe-abort, 충돌은 일시정지(MERGE_HEAD 유지). |
| `conflict-resolver.ts` | 충돌 일시정지 상태에서 `.git/MERGE_HEAD` 소유. 파일별 선택(ours/theirs/manual/keep/remove), continue=커밋, abort=복원. 마커 잔존 stage 차단. |
| `diff-viewer.ts` | PR식 diff(worktree 브랜치 vs merge-base) 읽기. 순수 read. |
| `gh-status-reader.ts` | `gh` CLI 읽기전용으로 PR/CI 상태(keyring 인증, 앱은 토큰 비보유). 8-kind union + 체크별 행. not-pushed는 ls-remote로 구분. |
| `fanout-manager.ts` | 활성 팬아웃 1건 소유. N worktree + 헤드리스 `claude -p` 레인 병렬 spawn, 레인별 결과(diff 재사용), abort/select(승자 머지). |

### `pty/` — 터미널 + 세션 영속화
- `pty-factory.ts` — 부팅 시 node-pty 로드(APP_PING에 버전 보고), `spawn → IPtyLike`(테스트/실물 통일 인터페이스).
- `agent-launcher.ts` — launch 동작의 **Branch-by-Abstraction** seam. `DirectLauncher`(b-lite: `claude` / `claude --continue` 직접 실행).
- `abduco-launcher.ts` — b-full 구현. `abduco` 바이너리로 detach/reap/list/end, 재오픈 3-way 결정(attach vs continue vs fresh).
- `abduco-{exec,reap,session,path}.ts` — detached 세션 수명 헬퍼(부팅 시 번들 리소스에서 resolve, 없으면 null → b-lite로 강등).

### `sync/` — 크로스머신 가시성 (working tree 미접촉)
- `session-publisher.ts` — `crossMachineSessions==='on'`일 때 이 머신의 라이브 세션을 공유 git ref로 publish. spawn/kill/status 변화 시 호출.
- `session-ref-git.ts` / `session-ref-sync.ts` — 공유 ref에 브랜치 상태를 commit(plumbing, non-ff 재시도). **작업 트리를 절대 건드리지 않음.**
- `machine-identity.ts` — 안정적 머신 ID(hostname+user+repo hash)로 세션 출처 구분.

### `app/` · `ipc/` · `proc/` · `util/`
- `app/quit-controller.ts` — before-quit 수명: 전 창의 active-turn 집계 → 경고 → 확정 시 전 창 sweep.
- `app/window-registry.ts` — 멀티윈도우 라우팅 primitive: `requireCtxFrom`, 전 창 집계/sweep, `canonicalRepoRoot`(realpath dedup), `findCtxByRepoRoot`(동일 레포 focus 가드).
- `ipc/ipc-context.ts` — 창당 IpcContext: 창-바인딩 매니저 묶음 + 공유 store + repoRoot + 수명 플래그.
- `ipc/register-ipc.ts` — 모든 IPC 핸들러 + 이벤트 emitter 조립. 매니저 lazy 생성(repoRoot 미정 가드), `contexts` 맵 라우팅.
- `proc/process-runner.ts` — main측 서브프로세스(verify/server/fanout 레인) child_process 래퍼(PTY 아님).
- `util/` — `resolve-repo-root`(Finder cwd/recentRepos에서 레포 루트), `detect-runner`(gradlew/npm), `find-free-port`.

## IPC 아키텍처

- **계약**: `src/shared/ipc-contract.ts`의 `MangoApi`가 단일 진실. preload가 이를
  `contextBridge.exposeInMainWorld('mango', …)`로 노출 → 렌더러는 `window.mango.<도메인>.<메서드>()`.
- **채널**: `src/shared/ipc-channels.ts`에 도메인별로 묶인 49 채널(APP/WORKTREE/SESSION/
  SERVER/LOG/MERGE/DIFF/GH/SETTINGS/SCROLLBACK/REPO/CROSS_MACHINE/FANOUT). invoke(왕복) +
  event(main→renderer) + fire-and-forget(input/resize).
- **멀티윈도우 라우팅**: 채널당 핸들러는 **하나**. 각 핸들러가 `requireCtxFrom(contexts, event)`로
  `event.sender.id → IpcContext`를 풀어 그 창의 매니저만 본다. 창-바인딩 매니저(worktree/session/
  server/…)는 ctx.repoRoot에 묶이고, 전역 store(session/settings/scrollback) 3개만 전 창 공유.

```ts
ipcMain.handle(IPC.WORKTREE_LIST, (event) => {
  const ctx = requireCtxFrom(contexts, event); // sender.id → ctx
  return ctx.worktreeManager?.list() ?? [];     // 그 창 전용
});
```

## Renderer 구조

- **`App.tsx`** — 마운트 시 rehydrate(레포 picker, 세션 레코드, settings, 서버 상태). `selectedId` +
  `paneMode`('terminal'|'diff'|'conflict'|'browser') 오케스트레이션. 무거운 청크는 `React.lazy`
  (AgentTerminal=xterm, DiffView/ConflictView=monaco ~3.9MB, FanoutView).
- **`components/`** — sidebar(worktree 목록·상태 dot) · terminal(xterm) · diff/conflict(monaco) ·
  logs(필터) · toolbar(server/merge/gh 컨트롤) · settings · fanout · browser(`<webview>`) · cross-machine.
- **`hooks/`** — IPC 도메인별 `use-*`(worktrees/session/server/logs/merge/diff/gh/settings/fanout/
  cross-machine/repo/conflicts/…). 렌더러 상태의 본체. **상태 라이브러리(zustand 등) 미사용.**
- **`lib/`** — 순수 헬퍼: `detect-server-url`(로그에서 `localhost:NNNN`), `log-filter`(grep+레벨),
  `format-versions`. `state/app-store.ts`는 사이드바 행 상태를 접는 **순수 fold**(스토어 아님).

## 설계 불변식 (load-bearing)

1. **단일 MERGE_HEAD** — 레포에 `.git/MERGE_HEAD`는 하나뿐 → 일시정지된 머지는 한 worktree가
   전역 소유. `ConflictResolver.owner()`가 소유 worktreeId 반환, 렌더러는 선택된 worktree가 아니라
   **소유 worktree**에 충돌 귀속. 앱 재시작에도 `.git/MERGE_HEAD`에서 진실 재계산.
2. **명령은 렌더러에서 안 받는다** — server/verify/agent 명령은 자동감지 + 환경 seam(`MANGO_*`)에서만.
   Settings UI 편집은 매니저가 idle일 때만 적용. 셸 인젝션 차단.
3. **순수 코어 + 주입 이펙트** — 매니저/러너는 생성자 주입(emitter·clock·git·process)으로 Electron/
   git/셸 없이 테스트. register-ipc가 실물 배선, 테스트는 fake 주입.
4. **창당 IPC 컨텍스트** — 각 BrowserWindow ↔ IpcContext(webContents.id 등록). 같은 레포는 두 창에
   못 열림(`canonicalRepoRoot` dedup + focus 가드) — 공유 MERGE_HEAD/store race 방지.
5. **b-lite vs b-full** — b-lite: 종료 후 프로세스 미유지, 재시작 시 `claude --continue` 복원.
   b-full(abduco): 의도적 detach 세션이 종료/크래시를 **생존**해 재attach. 부팅 시 record-driven
   reap으로 고아만 정리(다른 install/격리 스모크 세션은 절대 미접촉).
6. **턴 감지 = 출력 활동 휴리스틱** — `lastOutputAt`이 `ACTIVE_TURN_MS`(1500ms) 내면 active.
   claude TUI 문자열 변화에 무관. 종료 경고 + b-full keep-alive 결정 구동.
7. **before-quit 전 창 sweep** — QuitController가 모든 창의 live/active-turn 집계 → 경고 → 확정 시
   `sweepAll`로 전 창 세션 kill + 서버 dispose. 고아 `claude`/서버 프로세스 0.
8. **크로스머신은 가시성-only** — git ref로 포인터만 주고받고 **작업 트리·대화는 절대 동기화 안 함**
   (claude resume는 cwd 종속이라 원격 재개 불가 — P0 스파이크로 확인 후 설계 축소).

## 테스트 / 빌드

- **vitest 2 프로젝트**: `node`(`tests/main/**`, git 실연동, forks, 30s) +
  `jsdom`(`tests/renderer/**`, RTL, threads, 5s). 55파일 · 503 tests. Electron은
  `__mocks__/electron.ts`로 목.
- **CI**(`.github/workflows/ci.yml`): PR + main push마다 typecheck·lint·format:check·test·build.
  최소 권한(`contents: read`), actions @v5(Node 24), concurrency-cancel.
- **패키징**(electron-builder): macOS arm64 **dmg**, `appId: me.onda.mangolove-idea`,
  `identity: null`(ad-hoc 서명), `asarUnpack`으로 node-pty 네이티브 추출, `extraResources`로
  abduco 바이너리 + THIRD-PARTY-LICENSES 번들.
