# v2 — 크로스머신 세션 (Cross-Machine Sessions)

> 설계 문서. 2026-06-23. 트랙: Large. 의존: b-full(머지됨 @ f36549b).
> 브레인스토밍 합의 기반. 구현 전 Phase 0 스파이크 GO 필수.

## 1. 목표 / 범위

한 머신(A)에서 작업하던 MangoLove/claude 세션을 다른 머신(B)에서 **이어받고(재개)**, B에서 모든 머신의 세션을 **조회(가시성)**한다.

- **재개**: B에서 A의 세션을 이어받기 — 해당 branch를 worktree로 띄우고 `claude --resume <sessionId>` 실행. claude가 클라우드에서 대화를 복원한다.
- **가시성**: B에서 머신별 세션 목록·상태(running/idle/ended, hasActiveTurn)를 본다.

### 비범위 (YAGNI)
- 대화 내용 저장/전송 — **claude 클라우드가 담당**(사용자 확인). MangoLove는 대화를 절대 저장하지 않는다 (b-full '대화 무저장' 원칙 유지).
- 실행 중 OS 프로세스의 물리적 이동 — 불가능.
- 실시간 폴링 — 자동 push + 수동 조회로 충분(아래 4).

## 2. ⚠️ 전제 = Phase 0 스파이크 (GO/NO-GO)

기능 전체가 가정 2개 위에 있다. 인프라 구축 전 먼저 실증한다 (b-full 선례).

- **(a) 세션 id 확보 — 사실상 해결.** claude는 `--session-id <uuid>`(주입)와 `--resume <uuid>`(재개)를 지원한다. MangoLove가 fresh spawn 시 uuid를 **생성·주입**하고 포인터에 기록하면 파일 watch 없이 id를 확보한다. 스파이크에서 주입한 id로 그 세션이 실제 생성되는지만 확인한다.
- **(b) 크로스-경로 재개 — 핵심 미검증.** claude 세션 JSONL은 `~/.claude/projects/<sanitized-cwd>/<id>.jsonl`처럼 **cwd 경로로 키잉**된다. 머신 B의 worktree 절대경로는 A와 다르다. `claude --resume <id>`가 **다른 경로에서도** 클라우드 동기화된 대화를 복원하는가?
  - **GO**: 경로 무관하게 id로 복원됨 → 설계대로 진행.
  - **NO-GO**: 경로 종속 → 재설계. 대안: ① 동일 상대경로 worktree 강제 + claude 프로젝트 매핑 보정, ② MangoLove가 JSONL까지 동기화(대화 무저장 원칙 재검토 — 사용자 재승인 필요).

스파이크 산출물: 2-머신(또는 2-userData/2-경로) 환경에서 `--session-id`로 세션 생성 → 클라우드 동기화 → 다른 경로에서 `--resume` 복원 성공/실패 실측 로그.

## 3. 아키텍처 (additive — b-lite/b-full 무변경)

### 3.1 세션 포인터 모델 (`src/shared/types.ts`)
```
interface CrossMachineSessionPointer {
  branch: string;            // 세션이 속한 branch (worktree 식별 키)
  claudeSessionId: string;   // MangoLove가 생성·주입한 uuid (재개 키)
  status: 'running' | 'idle' | 'ended';
  hasActiveTurn: boolean;
  machineId: string;         // 비식별 생성 id (파일 네임스페이스 <machineId>.json)
  machineLabel: string;      // 선택적 친화 라벨 (예: "work-mac"), 기본 = "machine-<id앞4>"
  updatedAt: number;
}
```
**대화 내용 0 — 메타데이터만.** hostname 원시값은 절대 포함하지 않는다.

### 3.2 머신 식별자 (`settings`)
머신당 1회 생성·영속하는 안정 `machineId`(비식별) + 사용자 설정 가능한 `machineLabel`. 기본 라벨은 비식별 생성값. **원시 OS hostname은 저장·전송하지 않는다.**

### 3.3 Git ref 동기화 (`src/main/sync/session-ref-sync.ts`)
- 전송 채널: repo의 **전용 orphan 브랜치** `mangolove-sessions`(기본안). 각 머신은 그 안의 **자기 파일** `<machineId>.json`만 커밋·push. main/feature 브랜치 오염 0.
  - 기본안으로 orphan 브랜치를 택한 이유: per-machine 파일이라 내용 충돌이 구조적으로 없고, 일반 push/fetch라 커스텀 refspec·blob-ref의 전송 엣지케이스가 없다(가장 표준적). 대안인 `refs/mangolove/sessions/<machineId>` 전용 ref는 P0/P1에서 push/fetch 신뢰성이 동등 검증되면 채택 가능 — 결정은 P1.
- **충돌-프리**: 각 머신은 **자기 파일만** 갱신. 동시 push는 브랜치 tip 레벨에서만 경합 → fetch-before-push(+ 자기 파일만 재적용) 재시도.
- 쓰기: 이 머신의 포인터 배열 직렬화 → `<machineId>.json` 커밋 → `git push origin mangolove-sessions`.
- 읽기: `git fetch origin mangolove-sessions` → 브랜치 내 모든 `*.json` 읽어 합산.
- 순수 코어(직렬화·합산·네임스페이스·"remote에 있는 branch만" 필터) + 주입된 git 효과(execFile/simple-git)로 분리 — 단위 테스트 가능(b-full 패턴).

### 3.4 세션 id 주입 (`src/main/pty/agent-launcher.ts` 계열)
fresh spawn 시 `--session-id <생성uuid>`를 argv에 추가하고 그 uuid를 포인터에 기록. continue/attach 경로는 기존 동작 유지. **결정적 코드가 uuid 생성·기록**(LLM 위임 아님).

### 3.5 크로스머신 UI (renderer)
- 머신별 그룹 + 상태 배지 목록.
- **타 머신** 포인터에 "여기서 재개" 액션 → 해당 branch worktree 보장(WorktreeManager 재사용) → `claude --resume <claudeSessionId>` 기동.
- 자기 머신 세션은 기존 UI로 처리.

## 4. 데이터 흐름

- **머신 A (push)**: 세션 spawn/end/상태변화 → 자기 ref 갱신 → **자동 push**. best-effort(실패해도 로컬 동작 무영향, b-full reap과 동일 철학).
- **머신 B (조회·재개)**: "새로고침" → 전체 ref fetch → 포인터 목록 표시 → "여기서 재개" → worktree + `claude --resume`.
- 동기화 시점: **자동 push + 수동 조회**(실시간 폴링 없음 — 비용·복잡도 회피).

## 5. 프라이버시 (3중 방어)

공유 remote에 메타데이터가 올라가므로:
1. **opt-in**: `crossMachineSessions: 'off' | 'on'`, **기본 off**. on일 때만 push/fetch.
2. **비식별 머신 id + 선택적 라벨**: 원시 hostname 미전송.
3. **이미 remote에 있는 branch의 포인터만 동기화**: 로컬 전용 branch명 유출 방지.
- session id는 재개에 필수라 동기화(대화 식별자 — 자격증명 아님). 문서·UI에 "세션 메타데이터가 공유 remote에 올라감" 명시.

## 6. 마이그레이션 전략

**해당 없음** (순수 additive — 기존 b-lite/b-full 경로 무변경). Large라 4단계로 분리, 각 단계 독립 검증·롤백 지점:

| Phase | 내용 | 완료 기준(롤백 지점) |
|-------|------|---------------------|
| **P0 스파이크** | (a)(b) 실증 | GO/NO-GO 판정. NO-GO면 재설계 |
| **P1** | 포인터 모델 + machineId + session-id 주입 + ref 동기화 코어(UI無) | 단위테스트 green, 2-userData ref push/fetch 합산 실증 |
| **P2** | 자동 push 트리거(spawn/end/상태) | 상태변화 시 ref 갱신·push 실증 |
| **P3** | UI(가시성 + "여기서 재개") + opt-in 설정 | 2-머신 스모크: A세션 → B에서 조회·재개 |

## 7. 리스크

- **(b) 크로스-경로 재개** — 최대 리스크, P0에서 판정.
- session-id 주입이 기존 continue/attach 3-way 결정과 충돌하지 않게 배선(b-full launcher seam 재사용).
- git ref non-fast-forward 레이스 → fetch-before-push 재시도.
- 프라이버시 — §5로 완화, 그래도 opt-in 동의 UI 필수.

## 8. 테스트

- 단위: 포인터 직렬화/역직렬화, 머신 네임스페이스 합산, 충돌-프리(자기 네임스페이스만 갱신), "remote에 있는 branch만" 필터, session-id 주입 argv.
- 스모크: 2-userData(또는 2-경로) ref push/fetch/합산 + `--session-id`/`--resume` 왕복. 2-머신 수동 스모크(가능 시).

## 9. 재사용 자산
- WorktreeManager(create/ensure), agent-launcher seam(b-full), SessionManager 상태(hasActiveTurn/status), settings-store, simple-git(await import).
- b-full의 순수코어+주입효과 테스트 패턴, best-effort 비차단 철학(reap).
