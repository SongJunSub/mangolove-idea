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
} as const;

/** Every message key, derived from the English catalog (the single source of truth). */
export type MessageKey = keyof typeof en;

/** Korean catalog. Typed so it MUST cover exactly the English keys (compile-time check). */
export const ko: Record<MessageKey, string> = {
  'settings.title': '설정',
  'settings.saved': '✓ 저장됨',
  'settings.done': '닫기',

  'settings.language': '언어',
  'settings.language.system': '시스템',
  'settings.language.ko': '한국어',
  'settings.language.en': 'English',

  'settings.theme': '테마',
  'settings.theme.dark': '다크',
  'settings.theme.light': '라이트',
  'settings.theme.system': '시스템',

  'settings.blankHint': '비워두면 환경변수 → 기본값 순으로 사용됩니다.',
  'settings.agentCommand': '에이전트 명령',
  'settings.verifyCommand': '검증 명령',
  'settings.serverCommand': '서버 명령',
  'settings.baseBranch': '기준 브랜치',
  'settings.autoDetect': '(자동 감지)',

  'settings.persist.label': '종료 후에도 에이전트를 백그라운드로 유지 (b-full)',
  'settings.persist.hint':
    '에이전트를 abduco 세션으로 감싸 진행 중인 턴이 종료/크래시에도 살아남고 재시작 시 다시 연결됩니다. macOS 전용.',
  'settings.persist.missing':
    '⚠ abduco를 찾을 수 없어 b-full이 비활성화되고 세션이 lite로 폴백됩니다. 설치:',
  'settings.persist.active':
    '✓ b-full 활성 — 에이전트가 종료/크래시에도 유지되고 재시작 시 재연결됩니다.',
  'settings.stopAll': '백그라운드 에이전트 모두 중지',
  'settings.stopping': '중지 중…',
  'settings.stoppedNote': '모든 백그라운드 에이전트를 중지했습니다.',

  'settings.crossMachine.label': '이 머신의 세션을 다른 머신과 공유 (조회 전용)',
  'settings.crossMachine.hint':
    '세션 메타데이터(브랜치 + 상태, 대화 내용은 절대 아님)를 공유 원격에 게시해 다른 머신의 세션을 볼 수 있게 합니다. 기본값은 꺼짐.',
  'settings.crossMachine.machineLabel': '이 머신 라벨',

  'settings.codenav.title': '코드 내비게이션 (Java / Kotlin)',
  'settings.codenav.hint':
    'Java/Kotlin의 Command+클릭 정의로 이동은 설치된 언어 서버를 사용합니다 (TS/JS는 기본 내장). 아래 경로를 지정하면 PATH 감지를 덮어씁니다.',
  'settings.codenav.available': '사용 가능',
  'settings.codenav.checking': '확인 중…',
  'settings.codenav.javaPath': 'jdtls 경로 (Java)',
  'settings.codenav.kotlinPath': 'kotlin-language-server 경로',

  'settings.updates.title': '업데이트',
  'settings.updates.current': '현재 버전:',
  'settings.updates.check': '업데이트 확인',
  'settings.updates.checking': '확인 중…',
  'settings.updates.available': 'v{version} 사용 가능.',
  'settings.updates.download': '다운로드',
  'settings.updates.upToDate': '최신 버전을 사용 중입니다.',
  'settings.updates.failed': '확인 실패 ({reason}) — 잠시 후 다시 시도하세요.',
  'settings.updates.unsignedHint':
    '서명되지 않은 빌드: 업데이트는 .dmg로 받아 Applications에 끌어다 놓습니다.',
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
