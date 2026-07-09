# MangoLove IDEA — 프로젝트 컨벤션

이 파일은 이 레포에서 작업하는 에이전트의 프로젝트 단위 규칙이다. 세션 메모리가 아니라
레포에 커밋되어 모든 세션·모든 머신에서 동일하게 적용된다.

## 커밋 & 푸시 — 묻지 않고 자율 수행

**검증이 통과하면 커밋과 푸시(main 머지 포함)를 사용자에게 다시 묻지 않고 자율적으로 끝낸다.**
"커밋할까요?" / "푸시할까요?" 를 되묻지 않는다.

- 자율 수행 조건(전부 충족): 셀프 리뷰 + 빌드 + 린트 + 타입체크 + 테스트 + 해당 트랙의 코드 리뷰 +
  DoD 항목이 모두 PASS.
- 하나라도 FAIL이면 커밋하지 않고 해당 단계로 돌아가 수정한다. (이 규칙은 "묻지 않는다"이지
  "검증을 건너뛴다"가 아니다.)
- 예외(이때만 먼저 확인): `strict.md`의 dry-run 게이트 대상(운영 데이터 변경, 외부 시스템 write,
  `git push --force`, 공유 브랜치 rebase, 시크릿 회전 등 되돌리기 어려운 작업), 또는 사용자가
  명시적으로 "커밋하지 말고"라고 한 경우.

## Git 워크플로우 — feature 브랜치 → `--no-ff` 머지 → main 푸시

레포의 모든 변경은 이 흐름을 따른다 (git log가 전부 이 패턴이다):

1. `main`에서 작업 브랜치 생성 (예: `feature/<요약>`, `fix/<요약>`, `chore/<요약>`)
2. 브랜치에 커밋 — Conventional Commits, footer에 `Change-Track: <Trivial|Small|Medium|Large>` 기재
3. `git checkout main && git merge --no-ff <branch>` — 머지 커밋 메시지: `Merge: <한글 요약> — <Track>`
4. `git push origin main`
5. 머지된 작업 브랜치는 삭제

- 커밋 메시지 body/footer는 Conventional Commits(전역 CLAUDE.md) 규칙을 따른다.
- 커밋 트레일러 마지막 줄: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## 검증 명령

- 타입체크: `npm run typecheck`
- 린트: `npm run lint`
- 테스트: `npm run test` (전체) · `npm run test:unit` (빠른 단위, integration 제외) · `npm run test:integration` (real-git만)
- 빌드: `npm run build`
- **전체 게이트: `npm run verify`** (typecheck → lint → test → build 를 **순차** 실행) · 스모크까지: `npm run verify:full`

### 테스트 풀 구조 & 동시 실행 금지

- vitest 는 3 프로젝트로 분리된다: `node`(빠른 단위, 병렬), `jsdom`(렌더러), `integration`(real-git 통합, **직렬** `fileParallelism:false`).
- real-git 서브프로세스를 띄우는 테스트는 파일명을 **`*.integration.test.ts`** 로 지어 `integration` 풀에 넣는다 (규약). 그래야 빠른 `node` 풀이 hermetic·병렬안전하게 유지되고 pass/fail 이 주변 CPU 부하에 의존하지 않는다.
- **`npm run build` 와 `npm run test` 를 동시에 돌리지 말 것** — CPU 경합으로 real-git integration 테스트가 타임아웃하며 거짓 실패한다. 항상 `npm run verify`(순차) 를 쓰거나, 손으로 돌릴 땐 test → build 순서로.
