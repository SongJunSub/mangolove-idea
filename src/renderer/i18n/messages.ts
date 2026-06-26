// Zero-dependency i18n catalog. `en` is the source of truth: its keys define the
// MessageKey union, and `ko` is typed as Record<MessageKey, string> so a missing or
// stray Korean key is a COMPILE error (the catalogs can never drift apart). Strings
// may contain {name} placeholders filled by format() / t(key, params).

/** The two supported UI languages (the resolved locale, never 'system'). */
export type Locale = 'ko' | 'en';

/** English catalog — the source of truth for the set of message keys. */
export const en = {
  // Settings modal — chrome
  'settings.title': 'Settings',
  'settings.saved': '✓ Saved',
  'settings.done': 'Done',

  // Settings — language
  'settings.language': 'Language',
  'settings.language.system': 'System',
  'settings.language.ko': '한국어',
  'settings.language.en': 'English',

  // Settings — theme
  'settings.theme': 'Theme',
  'settings.theme.dark': 'Dark',
  'settings.theme.light': 'Light',
  'settings.theme.system': 'System',

  // Settings — commands
  'settings.blankHint': 'Blank = fall back to the env seam, then the default.',
  'settings.agentCommand': 'agent command',
  'settings.verifyCommand': 'verify command',
  'settings.serverCommand': 'server command',
  'settings.baseBranch': 'base branch',
  'settings.autoDetect': '(auto-detect)',

  // Settings — b-full session persistence
  'settings.persist.label': 'Keep the agent running in the background after quit (b-full)',
  'settings.persist.hint':
    'Wraps the agent in an abduco session so an in-flight turn survives quit/crash and re-attaches on reopen. macOS only.',
  'settings.persist.missing':
    '⚠ abduco not found — b-full is disabled and sessions fall back to lite. Install it:',
  'settings.persist.active': '✓ b-full active — agents survive quit/crash; reopen re-attaches.',
  'settings.stopAll': 'Stop all background agents',
  'settings.stopping': 'Stopping…',
  'settings.stoppedNote': 'All background agents stopped.',

  // Settings — cross-machine
  'settings.crossMachine.label': "Share this machine's sessions across machines (visibility only)",
  'settings.crossMachine.hint':
    'Publishes session metadata (branch + status, never the conversation) to the shared remote so you can see sessions from your other machines. Off by default.',
  'settings.crossMachine.machineLabel': 'this machine label',

  // Settings — code navigation
  'settings.codenav.title': 'Code navigation (Java / Kotlin)',
  'settings.codenav.hint':
    'Command+click go-to-definition for Java/Kotlin uses your installed language server (TS/JS works built-in). Set a path below to override PATH detection.',
  'settings.codenav.available': 'available',
  'settings.codenav.checking': 'checking…',
  'settings.codenav.javaPath': 'jdtls path (Java)',
  'settings.codenav.kotlinPath': 'kotlin-language-server path',

  // Settings — updates
  'settings.updates.title': 'Updates',
  'settings.updates.current': 'Current version:',
  'settings.updates.check': 'Check for updates',
  'settings.updates.checking': 'Checking…',
  'settings.updates.available': 'v{version} is available.',
  'settings.updates.download': 'Download',
  'settings.updates.upToDate': "You're on the latest version.",
  'settings.updates.failed': "Couldn't check ({reason}) — try again later.",
  'settings.updates.unsignedHint':
    'Unsigned build: an update downloads as a .dmg you drag into Applications.',

  // Usage widget (bottom-left status bar)
  'usage.session': 'Session',
  'usage.weekly': 'Weekly',
  'usage.model': 'Model',
  'usage.loading': 'Claude usage…',
  'usage.none': 'No usage',
  'usage.refresh': 'Refresh',
  'usage.resetSoon': 'resets soon',
  'usage.resetInHM': 'resets in {h}h {m}m',
  'usage.resetInM': 'resets in {m}m',
  'usage.resetAt': 'reset: {at}',
  'usage.error.noLogin': 'Claude not connected',
  'usage.error.denied': 'Keychain access denied',
  'usage.error.rateLimited': 'Usage — retry shortly',
  'usage.error.failed': "Couldn't load usage",

  // Update notification (bottom status bar + card)
  'update.available': 'Update available',
  'update.current': 'Current v{version}',
  'update.now': 'Update now',
  'update.whatsNew': "What's new",
  'update.later': 'Later',
  'update.dismiss': 'Dismiss',
  'update.failed': 'Update failed: {reason}',
  'update.phase.downloadingPct': 'Downloading {pct}%',
  'update.phase.downloadingMb': 'Downloading {mb}MB',
  'update.phase.verifying': 'Verifying…',
  'update.phase.staging': 'Preparing install…',
  'update.phase.applying': 'Installing & restarting…',

  // App chrome (titlebar actions, panes, tabs, editor, quit dialog)
  'app.repoChange': 'change repo',
  'app.fanout': '⑃ Fan-out',
  'app.fanoutTip': 'Multimodel fan-out',
  'app.machines': '⌘ Machines',
  'app.machinesTip': 'Cross-machine sessions',
  'app.project': 'Project',
  'app.worktrees': 'Worktrees',
  'app.selectWorktree': 'Select a worktree to start its agent.',
  'app.loadError': 'Load failed: {error}',
  'app.saveError': 'Save failed: {error}',
  'app.editor': 'Editor',
  'app.save': 'Save',
  'app.saving': 'Saving…',
  'app.saveTip': 'Save ⌘S',
  'app.editorEmpty': 'Select a file to edit it here.',
  'app.editorLoading': 'Loading editor…',
  'app.readonly.binary': 'Binary file',
  'app.readonly.tooLarge': 'File too large (over 5MB)',
  'app.readonly.encoding': 'Not a UTF-8 file',
  'app.readonly.default': 'Read-only',
  'app.worktreeView': 'worktree view',
  'app.tab.terminal': 'Terminal',
  'app.tab.diff': 'Diff',
  'app.tab.browser': 'Browser',
  'app.tab.usages': 'Usages',
  'app.tab.conflicts': 'Conflicts',
  'app.loadingTerminal': 'Loading terminal…',
  'app.loadingDiff': 'Loading diff…',
  'app.loadingConflicts': 'Loading conflicts…',
  'app.loadingFanout': 'Loading fan-out…',
  'app.repoEmpty': 'Select your git repository to begin',
  'app.repoPick': 'Select repository…',
  'app.quit.title': 'Quit MangoLove IDEA?',
  'app.quit.fullPersist':
    '{count} agent turn(s) are running. With background persistence on, they keep running in the background and re-attach when you reopen — nothing is lost. You can also stop them now.',
  'app.quit.lite':
    '{count} running agent turn(s) would be interrupted. Conversations are saved by claude and resume with --continue next time — only the in-flight turn is lost. Quit anyway?',
  'app.quit.unsaved':
    '{count} unsaved editor file(s) will be lost — they were never saved to disk.',
  'app.quit.cancel': 'Cancel',
  'app.quit.stopAll': 'Stop all & quit',
  'app.quit.keepRunning': 'Keep running & quit',
  'app.quit.anyway': 'Quit anyway',
} as const;

/** Every message key, derived from the English catalog (the single source of truth). */
export type MessageKey = keyof typeof en;

/** Korean catalog. Typed so it MUST cover exactly the English keys (compile-time check). */
export const ko: Record<MessageKey, string> = {
  'settings.title': '설정',
  'settings.saved': '✓ 저장했어요',
  'settings.done': '완료',

  'settings.language': '언어',
  'settings.language.system': '시스템',
  'settings.language.ko': '한국어',
  'settings.language.en': 'English',

  'settings.theme': '테마',
  'settings.theme.dark': '다크',
  'settings.theme.light': '라이트',
  'settings.theme.system': '시스템',

  'settings.blankHint': '비워두면 환경변수, 그다음 기본값을 사용해요.',
  'settings.agentCommand': '에이전트 명령',
  'settings.verifyCommand': '검증 명령',
  'settings.serverCommand': '서버 명령',
  'settings.baseBranch': '기준 브랜치',
  'settings.autoDetect': '(자동으로 찾아요)',

  'settings.persist.label': '종료해도 에이전트를 백그라운드에서 계속 켜둬요 (b-full)',
  'settings.persist.hint':
    '에이전트를 abduco 세션으로 감싸서, 종료하거나 꺼져도 하던 작업이 이어지고 다시 열면 연결돼요. macOS에서만 돼요.',
  'settings.persist.missing': '⚠ abduco가 없어서 b-full을 못 켜고 lite로 동작해요. 설치하기:',
  'settings.persist.active':
    '✓ b-full이 켜져 있어요 — 종료하거나 꺼져도 에이전트가 유지되고, 다시 열면 연결돼요.',
  'settings.stopAll': '백그라운드 에이전트 모두 끄기',
  'settings.stopping': '끄는 중…',
  'settings.stoppedNote': '백그라운드 에이전트를 모두 껐어요.',

  'settings.crossMachine.label': '이 컴퓨터의 세션을 다른 컴퓨터와 공유해요 (보기 전용)',
  'settings.crossMachine.hint':
    '세션 정보(브랜치와 상태만, 대화 내용은 빼고)를 공유 원격에 올려서 다른 컴퓨터의 세션을 볼 수 있어요. 기본은 꺼져 있어요.',
  'settings.crossMachine.machineLabel': '이 컴퓨터 이름',

  'settings.codenav.title': '코드 내비게이션 (Java / Kotlin)',
  'settings.codenav.hint':
    'Java/Kotlin에서 Command+클릭으로 정의로 이동할 때 설치된 언어 서버를 써요 (TS/JS는 기본 내장이에요). 아래에 경로를 적으면 PATH 자동 감지 대신 그 경로를 써요.',
  'settings.codenav.available': '사용할 수 있어요',
  'settings.codenav.checking': '확인하고 있어요…',
  'settings.codenav.javaPath': 'jdtls 경로 (Java)',
  'settings.codenav.kotlinPath': 'kotlin-language-server 경로',

  'settings.updates.title': '업데이트',
  'settings.updates.current': '현재 버전:',
  'settings.updates.check': '업데이트 확인하기',
  'settings.updates.checking': '확인하고 있어요…',
  'settings.updates.available': 'v{version} 버전을 받을 수 있어요.',
  'settings.updates.download': '다운로드',
  'settings.updates.upToDate': '최신 버전을 쓰고 있어요.',
  'settings.updates.failed': '확인하지 못했어요 ({reason}) — 잠시 후 다시 시도해 주세요.',
  'settings.updates.unsignedHint':
    '서명되지 않은 빌드예요: 업데이트는 .dmg로 받아서 Applications에 끌어다 놓으면 돼요.',

  'usage.session': '세션',
  'usage.weekly': '주간',
  'usage.model': '모델',
  'usage.loading': 'Claude 사용량…',
  'usage.none': '사용량이 없어요',
  'usage.refresh': '새로고침',
  'usage.resetSoon': '곧 초기화돼요',
  'usage.resetInHM': '{h}시간 {m}분 후 초기화돼요',
  'usage.resetInM': '{m}분 후 초기화돼요',
  'usage.resetAt': '초기화: {at}',
  'usage.error.noLogin': 'Claude 연결이 필요해요',
  'usage.error.denied': '키체인 접근이 막혔어요',
  'usage.error.rateLimited': '잠시 후 다시 시도해요',
  'usage.error.failed': '사용량을 못 불러왔어요',

  'update.available': '업데이트가 있어요',
  'update.current': '현재 v{version}',
  'update.now': '지금 업데이트',
  'update.whatsNew': '새 소식',
  'update.later': '나중에',
  'update.dismiss': '닫기',
  'update.failed': '업데이트하지 못했어요: {reason}',
  'update.phase.downloadingPct': '받는 중 {pct}%',
  'update.phase.downloadingMb': '받는 중 {mb}MB',
  'update.phase.verifying': '확인하고 있어요…',
  'update.phase.staging': '설치를 준비하고 있어요…',
  'update.phase.applying': '설치하고 다시 시작할게요…',

  'app.repoChange': '저장소 변경',
  'app.fanout': '⑃ Fan-out',
  'app.fanoutTip': '여러 모델 동시 실행',
  'app.machines': '⌘ 컴퓨터',
  'app.machinesTip': '다른 컴퓨터의 세션',
  'app.project': '프로젝트',
  'app.worktrees': '워크트리',
  'app.selectWorktree': '워크트리를 선택하면 에이전트를 시작할 수 있어요.',
  'app.loadError': '불러오지 못했어요: {error}',
  'app.saveError': '저장하지 못했어요: {error}',
  'app.editor': '에디터',
  'app.save': '저장',
  'app.saving': '저장 중…',
  'app.saveTip': '저장 ⌘S',
  'app.editorEmpty': '파일을 선택하면 여기서 편집할 수 있어요.',
  'app.editorLoading': '에디터 불러오는 중…',
  'app.readonly.binary': '바이너리 파일',
  'app.readonly.tooLarge': '파일이 너무 커요 (5MB 초과)',
  'app.readonly.encoding': 'UTF-8 파일이 아니에요',
  'app.readonly.default': '읽기 전용',
  'app.worktreeView': '워크트리 보기',
  'app.tab.terminal': '터미널',
  'app.tab.diff': 'Diff',
  'app.tab.browser': '브라우저',
  'app.tab.usages': '사용처',
  'app.tab.conflicts': '충돌',
  'app.loadingTerminal': '터미널 불러오는 중…',
  'app.loadingDiff': 'Diff 불러오는 중…',
  'app.loadingConflicts': '충돌 불러오는 중…',
  'app.loadingFanout': 'Fan-out 불러오는 중…',
  'app.repoEmpty': 'Git 저장소를 선택하면 시작할 수 있어요',
  'app.repoPick': '저장소 선택…',
  'app.quit.title': 'MangoLove IDEA를 종료할까요?',
  'app.quit.fullPersist':
    '에이전트 {count}개가 작업 중이에요. 백그라운드 유지가 켜져 있어서 종료해도 계속 돌아가고, 다시 열면 연결돼요. 잃는 건 없어요. 지금 멈춰도 돼요.',
  'app.quit.lite':
    '작업 중인 에이전트 {count}개가 중단돼요. 대화는 claude가 저장해서 다음에 --continue로 이어갈 수 있고, 진행 중이던 작업만 사라져요. 그래도 종료할까요?',
  'app.quit.unsaved': '저장 안 한 파일 {count}개가 사라져요 — 디스크에 저장된 적이 없어요.',
  'app.quit.cancel': '취소',
  'app.quit.stopAll': '모두 멈추고 종료',
  'app.quit.keepRunning': '켜둔 채 종료',
  'app.quit.anyway': '그래도 종료',
};

/** The two catalogs, keyed by resolved locale. */
export const catalogs: Record<Locale, Record<MessageKey, string>> = { en, ko };

/** Replaces {name} placeholders in a template with the matching param (missing => left as-is). */
export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

/** A bound translate function for one locale (falls back to English, then the raw key). */
export type TranslateFn = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Builds the translate function for a resolved locale. */
export function makeT(locale: Locale): TranslateFn {
  const table = catalogs[locale];
  return (key, params) => format(table[key] ?? en[key] ?? key, params);
}
