# MangoLove IDEA — 설계 문서

> 상태: 브레인스토밍 / 설계 제시 후 사용자 확인 단계. 작성 2026-06-16.

## 목표 (한 줄)

IntelliJ는 특정 브랜치 디버깅 창으로 유지하고, **그 옆에서 worktree 기반으로 여러 브랜치를
병행 작업 + 로컬 서버 기동 + 로그 확인**을 하는 **GUI 데스크톱 앱**을 직접 만든다.
(Orca 체급, 단 Orca 포크가 아니라 처음부터 직접 구현 — 만드는 것 자체가 목적)

## 확정된 결정 사항

- **GUI 앱**으로 만든다 (슬래시 명령/CLI 아님)
- **처음부터 직접 구현** (Orca 포크 X) — 학습 / 완전 커스터마이즈 목적
- **로컬 서버는 한 번에 하나만 기동** → 포트/DB/미들웨어 격리 불필요 (가장 어려운 부분 회피)
- 브랜치 편집 / 에이전트는 병렬, 서버 기동만 단일
- 앱 이름: **MangoLove IDEA** / 레포: `~/Project/mangolove-idea`
- **세션 영속화 = b-lite** (2026-06-16 확정) — 살아있는 PTY 프로세스를 앱 종료 후 유지하지
  *않는다*. 대신 worktree별로 에이전트 세션 유무를 기억했다가 재시작 시 각 터미널에 `claude
  --continue`를 자동 실행해 같은 대화로 복귀시킨다. 대화 영속성 자체는 Claude Code가 디스크
  (`~/.claude/projects/<project>/<id>.jsonl`)에 이미 저장 → 앱은 대화 상태를 따로 저장하지 않는다.
  근거: 살아있는 프로세스가 추가로 사는 건 "종료 시점에 실행 중이던 턴" 한 가지뿐인데, 이는
  데몬이 아니라 **종료 경고 다이얼로그**로 충분. 주류 터미널도 의도적 종료 시 로컬 프로세스를
  살려두지 않음(peer 표준 일치).

## 확정 — 스택

**Electron + React + TypeScript** (2026-06-16 확정)
- 라이브러리: `node-pty`(PTY) · `xterm.js`(터미널 렌더) · `simple-git`(git) · `Monaco`(추후 diff)
- 선택 근거: 사용자 최강점(React/TS), Node 생태계가 PTY/프로세스/git을 성숙하게 지원 → 제작 속도 우선
- 보류된 대안: Tauri + React — Rust 학습이 목적이 되면 재검토. 코드 작성 전이라 전환 가능

## 다음 단계 (재개 시 여기부터)

- [x] 미해결 블로커 해소: "다른 터미널 세션 이어서 작업" → **세션 영속화 b-lite로 확정**, MVP에 항목 6 추가 (2026-06-16)
- [ ] MVP 범위(아래 v1, 항목 6 포함) 잠금 — 사용자 확인 완료
- [ ] 설계 문서를 spec으로 정식화 → `writing-plans` 로 구현 계획 분해
- [ ] Small/Medium 트랙 판정 후 Electron 스캐폴딩 시작 (vite + electron + react + ts)

## 아키텍처 (제시안)

```
Main 프로세스 (Node = 엔진)
  WorktreeManager  git worktree add/list/remove
  SessionManager   worktree마다 PTY로 `claude` 실행      ← node-pty
                   + 세션 레코드 영속화(b-lite): { worktreePath, branch,
                     hadActiveSession } → 재시작 시 `claude --continue` 자동 실행
                   + before-quit PTY kill-sweep (orphan claude 프로세스 방지)
  ServerManager    서버 1개 start/stop (한 번에 하나)     ← Spring Boot(gradlew)/npm 자동감지
  LogStore         서버 stdout/stderr → 링버퍼 + 파일
        │ IPC
Renderer (React = GUI)
  사이드바   worktree/브랜치 목록 + 상태(에이전트·서버)
  메인 탭    임베디드 터미널(xterm.js) = 에이전트 세션     ← 척추
  로그 패널  서버 로그 라이브 스트리밍 + grep/레벨 필터
  툴바       New worktree · Run · Stop · Merge
```

핵심 척추: **PTY(node-pty) + xterm.js** — 각 worktree에 진짜 터미널을 박아 `claude`를
인터랙티브로 실행/렌더링한다.

## MVP 범위 (v1)

넣음:
1. worktree 생성 / 목록 / 삭제 (base 브랜치 선택)
2. worktree마다 임베디드 에이전트 터미널 1개
3. 활성 worktree 로컬 서버 start/stop (한 번에 하나) + 라이브 로그 패널
4. 브랜치·서버 상태 사이드바
5. 머지 + 정리 버튼 (MangoLove 검증 훅 연결)
6. **세션 영속화 b-lite**: 재시작 시 worktree별 `claude --continue` 자동 실행 +
   종료 시 실행 중이던 턴이 있으면 경고 다이얼로그
   (cross-cutting 필수: before-quit PTY kill-sweep — 어느 선택이든 필요)

v2로 미룸 (YAGNI): Monaco diff 뷰어, PR/CI 패널, 브라우저 자동화, 멀티모델 팬아웃,
병렬 서버(포트/DB 격리), **세션 영속화 b-full**(tmux/abduco 래퍼로 실제 `claude` 프로세스
생존+재attach — "실행 중이던 턴 안 끊김"이 하드 요구가 될 때만, 데몬 말고 abduco 래퍼로),
xterm 스크롤백 디스크 저장·재생(@xterm/addon-serialize, 실험적), 크로스머신 세션 이동

## 차별점 (Orca 대비 직접 만드는 이유)

- MangoLove 방법론 내장: 트랙 분류 · DoD · 검증 게이트를 오케스트레이터가 강제
- CRS 스택 서버 자동감지 (Spring Boot gradlew / npm)
- 한국어 UI

## 컨텍스트 메모

- 사용자 환경: macOS, IntelliJ 메인, 헤비 Claude Code 유저
- CRS 레포: crs-be(Spring Boot), crs-admin-web / crs-be-web(React/TS)
- 비교 검토한 기존 도구: Conductor(Mac GUI), Claude Squad(터미널), Orca(MIT 오픈소스 ADE), Crystal→Nimbalyst
- 브레인스토밍 스킬 흐름상 다음: 설계 승인 → spec 정식화 → writing-plans
