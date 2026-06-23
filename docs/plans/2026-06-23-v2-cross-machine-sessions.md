# v2 — 크로스머신 세션 (가시성-only)

> 설계 문서. 2026-06-23. 트랙: Medium. 의존: b-full(머지됨 @ f36549b).
> P0 스파이크 결과 원안(포인터-only 재개) 폐기 → **가시성-only**로 재설계(사용자 결정 2026-06-23).

## 1. 목표 / 범위

여러 머신에서 작업하는 MangoLove 세션을 **머신 간에 조회**하고, 다른 머신의 branch 작업을 **현재 머신에서 이어가기 쉽게** 한다. **대화 내용은 동기화하지 않는다**(b-full '대화 무저장' 원칙 보존).

- **가시성**: 머신 B에서 모든 머신의 세션 목록·상태(running/idle/ended, hasActiveTurn, branch, 머신 라벨, 시각)를 본다.
- **컨텍스트 이어가기**: 타 머신 세션의 branch를 현재 머신에서 **새 세션으로 시작**(worktree 보장 + fresh spawn). 대화는 이어지지 않음을 UI에 명시.

### 비범위 (P0 스파이크로 확정)
- **대화 재개(conversation resume) 불가** — `claude --resume <id>`는 cwd 버킷 종속이라 크로스머신 재개는 대화 JSONL 운반을 요구. '대화 무저장' 원칙 위배 + 대화 전문(코드·시크릿)을 공유 remote에 못 올림 → **이번 범위에서 제외**(§2). 진짜 재개가 필요해지면 비공개·암호화 채널 별도 설계.
- 대화 내용 저장/전송, 실행 중 프로세스 이동, 실시간 폴링.

## 2. Phase 0 스파이크 기록 (실행 완료 2026-06-23) — 왜 가시성-only인가

claude 2.1.186, `-p` 소형 호출, 2-경로(A/B) 로컬 실측. 원안의 핵심 가정을 깨고 범위를 확정한 근거:

- **(a) 세션 id 주입 — ✅** `--session-id <uuid>` 주입 시 그 uuid로 세션 생성(`~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`).
- **(b) 크로스-경로 재개 — ❌** `claude --resume <id>`는 **현재 cwd 버킷만 조회**(전역 id 조회 없음). 다른 경로 = `No conversation found`. 동일 경로만 복원(대조 확정). `autoUploadSessions`도 *view-only* — CLI 재개 불가.
- **옵션(JSONL 운반) — ✅ 기술적 가능하나 채택 안 함** A의 JSONL을 B 버킷에 복사하면 복원되나, 이는 대화 전문 운반 = 원칙 위배 + 프라이버시 리스크. → **재개 제외, 가시성-only 채택.**

(상세 메모리: `claude-resume-cwd-bound`)

## 3. 아키텍처 (additive — b-lite/b-full/세션 spawn 경로 무변경)

### 3.1 세션 포인터 모델 (`src/shared/types.ts`)
```
interface CrossMachineSessionPointer {
  branch: string;            // 세션이 속한 branch (worktree 식별 키)
  status: 'running' | 'idle' | 'ended';
  hasActiveTurn: boolean;
  machineId: string;         // 비식별 생성 id (파일 네임스페이스)
  machineLabel: string;      // 선택적 친화 라벨, 기본 = "machine-<id앞4>"
  updatedAt: number;
}
```
**대화 내용 0, 세션 id 0** — 재개를 안 하므로 claude session id조차 불필요(YAGNI). 순수 메타데이터.

### 3.2 머신 식별자 (`settings`)
머신당 1회 생성·영속하는 안정 `machineId`(비식별) + 사용자 설정 가능 `machineLabel`. **원시 OS hostname은 저장·전송하지 않는다.**

### 3.3 Git 동기화 (`src/main/sync/session-ref-sync.ts`)
- 전송 채널: repo의 **전용 orphan 브랜치** `mangolove-sessions`. 각 머신은 그 안의 **자기 파일** `<machineId>.json`만 커밋·push. main/feature 오염 0.
  - orphan 브랜치 기본안 근거: per-machine 파일이라 내용 충돌 구조적 부재 + 일반 push/fetch(커스텀 refspec·blob-ref 엣지케이스 없음). 대안 `refs/mangolove/sessions/<machineId>` 전용 ref는 동등 검증되면 P1에서 채택 가능.
- **충돌-프리**: 각 머신은 **자기 파일만** 갱신. 동시 push는 브랜치 tip 레벨 경합 → fetch-before-push(+자기 파일만 재적용) 재시도.
- 쓰기: 이 머신 포인터 배열 직렬화 → `<machineId>.json` 커밋 → `git push origin mangolove-sessions`.
- 읽기: `git fetch origin mangolove-sessions` → 브랜치 내 모든 `*.json` 읽어 합산.
- 순수 코어(직렬화·합산·네임스페이스·"remote에 있는 branch만" 필터) + 주입된 git 효과(execFile/simple-git) 분리 — 단위 테스트 가능(b-full 패턴).

### 3.4 크로스머신 UI (renderer)
- 머신별 그룹 + 상태 배지 목록(자기 머신 포함).
- **타 머신** 포인터에 **"이 branch 여기서 시작"** 액션 → worktree 보장(WorktreeManager 재사용) + **fresh** 세션 spawn. **"대화는 이어지지 않음"** 명시.
- 자기 머신 세션은 기존 UI로 처리.

## 4. 데이터 흐름

- **머신 A (push)**: 세션 spawn/end/상태변화 → 자기 `<machineId>.json` 갱신 → **자동 push**. best-effort(실패해도 로컬 무영향, reap 철학).
- **머신 B (조회)**: "새로고침" → `mangolove-sessions` fetch → 전체 `*.json` 합산 표시 → "이 branch 여기서 시작" → worktree + fresh spawn.
- 동기화 시점: **자동 push + 수동 조회**(실시간 폴링 없음).

## 5. 프라이버시 (3중 방어)

공유 remote에 메타데이터가 올라가므로:
1. **opt-in**: `crossMachineSessions: 'off' | 'on'`, **기본 off**. on일 때만 push/fetch.
2. **비식별 머신 id + 선택적 라벨**: 원시 hostname 미전송.
3. **이미 remote에 있는 branch의 포인터만 동기화**: 로컬 전용 branch명 유출 방지.
- 대화 내용·세션 id는 애초에 동기화 대상이 아님(가시성-only). UI에 "세션 메타데이터(branch·상태·머신 라벨)가 공유 remote에 올라감" 명시.

## 6. 마이그레이션 전략

**해당 없음** (순수 additive — 기존 세션 spawn/b-lite/b-full 경로 무변경). 단계 분리, 각 단계 독립 검증·롤백 지점:

| Phase | 내용 | 완료 기준(롤백 지점) |
|-------|------|---------------------|
| ~~P0 스파이크~~ | ✅ 완료 → 가시성-only 확정 | — |
| **P1** | 포인터 모델 + machineId + ref-sync 코어(순수+주입, UI無) | 단위테스트 green, 2-userData orphan-branch push/fetch 합산 + "remote-branch만" 필터 실증 |
| **P2** | 자동 push 트리거(spawn/end/상태변화) + opt-in 설정 게이트 | off면 무동작, on이면 상태변화 시 자기 파일 push 실증 |
| **P3** | UI(머신별 가시성 + "이 branch 여기서 시작" fresh spawn) | 2-userData/2-머신 스모크: A세션 → B에서 조회 → fresh 시작 |

## 7. 리스크

- git push 실패/네트워크 단절 → best-effort, 로컬 동작 무영향. fetch-before-push 재시도로 non-fast-forward 레이스 처리.
- orphan 브랜치 최초 생성(빈 repo/권한) → 없으면 생성, push 권한 없으면 조용히 비활성 + 설정에 사유 표시.
- 프라이버시 — §5로 완화, opt-in 동의 UI 필수.
- "remote에 있는 branch만" 판정의 정확성(로컬-only branch 유출 방지) → 단위 테스트로 고정.

## 8. 테스트

- 단위: 포인터 직렬화/역직렬화, 머신 네임스페이스 합산, 충돌-프리(자기 파일만 갱신), "remote-branch만" 필터, machineLabel 기본값.
- 스모크: 2-userData(격리) orphan-branch push/fetch/합산 + opt-in on/off + "이 branch 여기서 시작" fresh spawn. 2-머신 수동 스모크(가능 시).

## 9. 재사용 자산
- WorktreeManager(create/ensure), SessionManager 상태(hasActiveTurn/status/liveWorktreeIds), settings-store, simple-git(await import), b-full 순수코어+주입효과 테스트 패턴 + best-effort 비차단 철학(reap).
