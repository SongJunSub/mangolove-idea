# MangoLove IDEA

worktree 기반 로컬 개발 오케스트레이터 — **GUI 데스크톱 앱** (Electron).

IntelliJ는 특정 브랜치 **디버깅 창**으로 두고, 그 옆에서 **여러 브랜치를 병행 작업 + 로컬 서버
기동 + 로그 확인 + 머지**를 한 화면에서 처리한다. 이름의 "IDEA"는 IntelliJ IDEA 옆에 나란히
둔다는 의미. Orca 체급을, 포크가 아니라 처음부터 직접 구현.

## 상태

**v1(MVP) + v2 백로그 전부 구현 완료.** CI green, 503 tests. 대상 플랫폼: **macOS arm64**.

- 아키텍처 상세: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 초기 설계(브레인스토밍 기록): [docs/DESIGN.md](docs/DESIGN.md)
- v2 백로그(규모·의존성·트리거): [docs/V2-BACKLOG.md](docs/V2-BACKLOG.md)
- 기능별 구현 계획: [docs/plans/](docs/plans/) · 수동 스모크 절차: [tests/smoke/](tests/smoke/)

## 다운로드 / 설치 (macOS arm64)

### 터미널 한 줄 (권장)

```bash
curl -fsSL https://raw.githubusercontent.com/SongJunSub/mangolove-idea/main/install.sh | bash
```

[install.sh](install.sh)가 최신 릴리즈 `.dmg`를 받아 `/Applications`(권한 없으면 `~/Applications`,
sudo 불필요)에 설치하고, **Gatekeeper quarantine을 제거**해 경고 없이 바로 열리게 합니다. 모든
단계를 출력하므로 감사 가능합니다. 커스텀 위치는 `MANGO_INSTALL_DEST=...`, 오프라인 설치는
`MANGO_INSTALL_DMG=/path/to.dmg`.

### Homebrew

```bash
brew tap SongJunSub/tap
brew trust SongJunSub/tap          # 1회: cask가 설치 후 스크립트를 실행하므로 필요
brew install --cask mangolove-idea
```

cask의 `postflight`가 설치 직후 quarantine을 제거하므로 **경고 없이 바로 열립니다**(별도 플래그
불필요 — 최신 Homebrew는 `--no-quarantine`을 제거했고 cask가 대신 처리). 그 post-install 스크립트가
코드를 실행하기 때문에 Homebrew가 **최초 1회 `brew trust SongJunSub/tap`**을 요구합니다(안 하면 cask
설치를 거부). 한 번 trust하면 이후 install·upgrade가 매번 깨끗합니다(경고 없음). 갱신·삭제는
`brew upgrade --cask mangolove-idea` / `brew uninstall --cask mangolove-idea`.
(tap: [SongJunSub/homebrew-tap](https://github.com/SongJunSub/homebrew-tap))

### 수동 (.dmg)

[**Releases**](https://github.com/SongJunSub/mangolove-idea/releases/latest)에서 `.dmg`를 받아
**MangoLove IDEA**를 `/Applications`로 드래그. 처음 열 때 "확인되지 않은 개발자" 경고가 뜨면
한 번만 허용:

- **시스템 설정 → 개인정보 보호 및 보안** → 아래로 스크롤 → **"확인 없이 열기"**, 또는
- 터미널: `xattr -dr com.apple.quarantine "/Applications/MangoLove IDEA.app"`

> ⚠️ **현재 빌드는 서명되지 않았습니다**(Apple 공증(notarization)은 Apple Developer Program
> $99/년 필요). 경고는 위 방법으로 한 번만 허용하면 됩니다 — 앱 동작은 정상입니다. 공증된(경고
> 없는) 빌드가 필요해지면 [docs/RELEASE-SIGNING.md](docs/RELEASE-SIGNING.md)의 서명 설정을 릴리즈
> 워크플로우 빌드 단계에 끼우면 같은 파이프라인이 notarized `.dmg`를 냅니다.

## 기능

### v1 (MVP)

- **worktree CRUD** — base 브랜치 선택, 생성/목록/삭제 (브랜치명 옵션 인젝션 방어)
- **임베디드 에이전트 터미널** — worktree마다 진짜 PTY로 `claude` 실행 (node-pty + xterm.js)
- **로컬 서버 start/stop + 라이브 로그** — gradlew(Spring) / npm 자동감지, 링버퍼 + grep/레벨 필터
- **브랜치·서버 상태 사이드바** — worktree별 에이전트·서버 상태 dot
- **머지 + 정리** — verify 훅 → 머지 → 선택적 worktree 제거
- **세션 영속화 b-lite** — 재시작 시 worktree별 `claude --continue` 자동 복귀 + 종료 시 진행 중 턴 경고

### v2

| 영역 | 기능 |
|---|---|
| 표시·편집 | **Monaco diff 뷰어**(브랜치 vs base, 읽기전용) · **머지 충돌 해결 UI**(base/ours/theirs 3-way) · **xterm 스크롤백** 직렬화/재생(worktree별 256KB) |
| 외부 연동 | **PR/CI 상태 패널**(`gh` CLI 읽기전용, 토큰 비보유 · 체크별 확장) · **임베디드 브라우저**(`<webview>`, 서버 URL 자동감지) |
| 에이전트 | **턴 감지**(출력 활동 휴리스틱) · **멀티모델 팬아웃**(1 프롬프트 → N worktree 헤드리스 `claude -p` 병렬, 레인별 diff + 승자 머지) |
| 인프라 | **병렬 서버**(worktree마다 동시 기동, distinct PORT 주입 5173~) · **멀티윈도우**(레포당 1창, webContents.id 바인딩) · **패키징**(electron-builder dmg, abduco 번들) |
| 세션 | **b-full 세션 영속화**(abduco detach — 턴이 앱 종료/크래시를 생존, 재attach) · **크로스머신 세션 가시성**(git ref로 다른 머신 세션 포인터 fetch) · **Settings UI** |

## 스택

**Electron 42 + React 19 + TypeScript 5.7** · `node-pty`(PTY) · `xterm.js`(터미널) ·
`simple-git`(git) · `Monaco`(diff/충돌) · electron-vite(번들) · vitest(테스트)

## 빠른 시작

```bash
npm install        # postinstall: electron-rebuild -f -w node-pty (아래 노트 참조)
npm run dev        # HMR로 앱 기동
```

배포 빌드:

```bash
npm run dist       # electron-vite build → electron-builder --mac --arm64 (dmg)
npm run dist:dir   # 서명/패키징 없이 .app 디렉토리만 (빠른 검증용)
```

## 스크립트

| Script | Purpose |
|---|---|
| `npm run dev` | HMR로 앱 기동 (electron-vite). |
| `npm run build` | main/preload/renderer를 `out/`로 번들. |
| `npm test` | vitest (node + jsdom 두 프로젝트). |
| `npm run typecheck` | `tsc --noEmit` (node + web 설정 각각). |
| `npm run lint` / `npm run format` | ESLint 9 flat config / Prettier. |
| `npm run dist` / `dist:dir` | dmg 패키징 / .app 디렉토리만. |
| `npm run rebuild` | Electron 버전 변경 후 node-pty 재빌드. |

## 아키텍처 한눈에

```
Main 프로세스 (Node = 엔진)
  managers/   WorktreeManager · SessionManager(PTY) · ServerManager · LogStore
              + SessionStore · SettingsStore · ScrollbackStore (corrupt-safe 원자적 저장)
  git/        MergeRunner · ConflictResolver · DiffViewer · GhStatusReader · FanoutManager
  pty/        PtyFactory · AgentLauncher(b-lite) ↔ AbducoLauncher(b-full, detach)
  sync/       SessionPublisher · machine-identity (크로스머신 가시성, working tree 미접촉)
  app/        QuitController(종료 sweep) · WindowRegistry(멀티윈도우 라우팅)
        │ IPC  (49 채널 · window.mango · Map<webContents.id, IpcContext> 라우팅)
Renderer (React = GUI)
  components/ sidebar · terminal(xterm) · diff/conflict(monaco, lazy) · logs · toolbar
              · settings · fanout · browser · cross-machine
  hooks/      IPC 도메인별 use-* (worktrees/session/server/logs/merge/diff/gh/...)
```

핵심 척추: **PTY(node-pty) + xterm.js** — 각 worktree에 진짜 터미널을 박아 `claude`를
인터랙티브로 실행/렌더링. 상세는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 테스트 / CI

- **55개 테스트 파일 · 503 tests.** node 프로젝트(`tests/main/**`, git 실연동 포함) +
  jsdom 프로젝트(`tests/renderer/**`, React Testing Library).
- **CI**([.github/workflows/ci.yml](.github/workflows/ci.yml)): PR + main push마다
  typecheck · lint · format:check · test · build 5게이트. red면 머지 차단.
- 수동 GUI 스모크 절차: [tests/smoke/](tests/smoke/) (monaco/xterm 바운드 컴포넌트는 jsdom 불가 → 스모크 영역).

## node-pty 네이티브 모듈

`node-pty@1.1.0`은 **N-API** 애드온으로 ABI-안정 prebuilt를 싣는다 — plain Node와 Electron
양쪽에서 재빌드 없이 로드된다. `postinstall`의 `electron-rebuild -f -w node-pty`는 보험:
`build/Release/pty.node`를 만들어 이 Electron에 핀(미래 node-pty가 prebuild를 끊을 경우 대비).

- Electron 버전 변경 후: `npm run rebuild`.
- 애드온이 진짜 깨진 증상: Ping 패널에 `node-pty <ver> (FAILED)`. 조치: `npm run rebuild`
  (+ C++ 툴체인 없으면 `xcode-select --install`).
- 네이티브 의존성은 번들 밖에 둔다: `dependencies`에 남기고 electron-vite의
  `externalizeDepsPlugin()`이 externalize, 런타임에 `node_modules`에서 로드.
- 패키징 시 `asarUnpack`으로 `node-pty/build/Release/*`를 asar 밖으로 추출.

## 방법론

이 레포는 **MangoLove 방법론**(트랙 분류 · DoD · 검증 게이트)으로 개발한다. 강제 규칙은
프롬프트가 아니라 결정적 게이트로 인코딩한다 — 포맷은 pre-commit 훅(`scripts/hooks/`),
typecheck/lint/test/build는 위 CI required check.

## 작업 이어가기

```bash
cd ~/Project/mangolove-idea
claude --continue      # 또는 claude --resume
```

세션 핸드오프 상태는 `.progress.md`(gitignore)에 있다. 새 세션이면
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) + `.progress.md`를 읽고 이어간다.
