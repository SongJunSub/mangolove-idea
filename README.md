# MangoLove IDEA

worktree 기반 로컬 개발 오케스트레이터 (GUI 데스크톱 앱).

IntelliJ는 특정 브랜치 **디버깅 창**으로 두고, 그 옆에서 **여러 브랜치를 병행 작업 +
로컬 서버 기동 + 로그 확인**을 한 화면에서 처리한다. 이름의 "IDEA"는 IntelliJ IDEA 옆에
나란히 둔다는 의미.

## 상태

브레인스토밍 / 설계 단계. 아직 구현 전.
- 설계 문서: [docs/DESIGN.md](docs/DESIGN.md)
- 진행 상태(세션 핸드오프): `.progress.md` (gitignore)

## 스택 (확정 2026-06-16)

Electron + React + TypeScript
(`node-pty` · `xterm.js` · `simple-git` · `Monaco`)

## MVP (v1)

- worktree 생성 / 목록 / 삭제 (base 브랜치 선택)
- worktree마다 임베디드 에이전트 터미널 (Claude Code, PTY + xterm.js)
- 활성 worktree 로컬 서버 start/stop (한 번에 하나) + 라이브 로그 패널
- 브랜치·서버 상태 사이드바
- 머지 + 정리 버튼 (MangoLove 방법론 검증 훅 연결)
- 세션 영속화 b-lite: 재시작 시 worktree별 `claude --continue` 자동 실행 (프로세스 생존은 v2)

## 작업 이어가기

다른 터미널/세션에서 재개:

```bash
cd ~/Project/mangolove-idea
claude --continue      # 또는 claude --resume
```

새 세션이면 `docs/DESIGN.md`와 `.progress.md`를 읽고 "다음" 항목부터 진행.
