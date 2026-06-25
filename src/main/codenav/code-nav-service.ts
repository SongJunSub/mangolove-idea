import { relative } from 'node:path';
import { isWithin, resolveExistingScopedPath } from '../fs/scoped-path';
import type {
  CodeNavQuery,
  CodeNavReferencesQuery,
  CodeNavResult,
  CodeNavLocation,
  CodeNavCapabilities,
  CodeNavLangStatus,
} from '../../shared/types';
import type { NavServerLanguage } from '../lsp/lsp-detect';

/** A raw LSP location BEFORE confinement: an absolute file path + a 0-based range. */
export interface RawLocation {
  readonly absPath: string;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

/** Inner query the LspManager understands: the CONFINED canonical absolute path of the
 *  active file (already realpath+isWithin-validated by CodeNavService) + a 0-based position. */
export interface LspQueryInner {
  readonly absPath: string;
  readonly line: number;
  readonly character: number;
  readonly includeDeclaration: boolean;
}

export interface CodeNavDeps {
  /** Trusted worktree ids (= absolute paths). */
  knownWorktreeIds(): Promise<ReadonlySet<string>>;
  /** Canonicalizes + follows symlinks; throws if missing. */
  realpathSync(p: string): string;
  /** Absolute server path for `lang`, or null when the toolchain is absent. */
  resolveServer(lang: NavServerLanguage): string | null;
  /** Safe reason string when a language is unavailable (no fs path). */
  reasonFor(lang: NavServerLanguage): string;
  /**
   * Runs an LSP query against the (worktreeId, lang) server, returning ABSOLUTE-path
   * locations. The LspManager spawns/reuses the server and MUST return [] on any
   * failure/timeout/absence and drop non-file (jdt://, decompiled) targets.
   */
  query(
    kind: 'definition' | 'references',
    worktreeId: string,
    lang: NavServerLanguage,
    q: LspQueryInner,
  ): Promise<readonly RawLocation[]>;
}

/** Extension -> the external-LSP language, or null (TS/JS never reach this service). */
function navServerLangOf(relPath: string): NavServerLanguage | null {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext === 'java') return 'java';
  if (ext === 'kt' || ext === 'kts') return 'kotlin';
  return null;
}

/**
 * Main-side facade for Java/Kotlin code navigation. Owns the SECURITY boundary: EVERY
 * location an LSP server returns (which may point at a JDK jar, node_modules, a sibling
 * worktree, or /usr/lib) is re-confined to the requesting worktree via realpath + isWithin
 * — the SAME gate as FILE_READ — and DROPPED if it escapes. A nav result is never a reason
 * to widen filesystem access. All failures degrade to an empty result; nothing throws to
 * the renderer (the handler also normalizes).
 */
export class CodeNavService {
  constructor(private readonly deps: CodeNavDeps) {}

  /** Per-language availability (PATH-detected). worktreeId reserved for future per-worktree. */
  async capabilities(_worktreeId: string): Promise<CodeNavCapabilities> {
    return { java: this.langStatus('java'), kotlin: this.langStatus('kotlin') };
  }

  private langStatus(lang: NavServerLanguage): CodeNavLangStatus {
    return this.deps.resolveServer(lang)
      ? { available: true }
      : { available: false, reason: this.deps.reasonFor(lang) };
  }

  async definition(req: CodeNavQuery): Promise<CodeNavResult> {
    return this.run('definition', req.worktreeId, req.relPath, req.line, req.character, false);
  }

  async references(req: CodeNavReferencesQuery): Promise<CodeNavResult> {
    return this.run(
      'references',
      req.worktreeId,
      req.relPath,
      req.line,
      req.character,
      req.includeDeclaration,
    );
  }

  private async run(
    kind: 'definition' | 'references',
    worktreeId: string,
    relPath: string,
    line: number,
    character: number,
    includeDeclaration: boolean,
  ): Promise<CodeNavResult> {
    const lang = navServerLangOf(relPath);
    if (!lang || !this.deps.resolveServer(lang)) return { locations: [] };
    // Confine the QUERY path itself (the active file) through the SAME audited gate as
    // FILE_READ — known-worktree + realpath + isWithin — so a hostile renderer cannot make
    // the LSP layer read a file outside the worktree (e.g. relPath '../../etc/passwd' or a
    // symlinked path). resolveExistingScopedPath gives both the canonical base + target.
    let baseReal: string;
    let absPath: string;
    try {
      const r = await resolveExistingScopedPath(this.deps, worktreeId, relPath);
      baseReal = r.baseReal;
      absPath = r.targetReal;
    } catch {
      return { locations: [] }; // unknown worktree / escape / missing -> degrade
    }
    let raw: readonly RawLocation[];
    try {
      raw = await this.deps.query(kind, worktreeId, lang, {
        absPath,
        line,
        character,
        includeDeclaration,
      });
    } catch {
      return { locations: [] }; // server crash/timeout -> degrade, never throw
    }
    return { locations: this.confineAll(baseReal, raw) };
  }

  /** Confine each location to the worktree; drop any that escapes (the security gate). */
  private confineAll(baseReal: string, raw: readonly RawLocation[]): CodeNavLocation[] {
    const out: CodeNavLocation[] = [];
    for (const loc of raw) {
      let targetReal: string;
      try {
        targetReal = this.deps.realpathSync(loc.absPath); // follows symlinks; throws if gone
      } catch {
        continue; // unresolvable target -> drop
      }
      if (!isWithin(baseReal, targetReal)) continue; // escapes the worktree -> drop
      out.push({
        relPath: relative(baseReal, targetReal),
        startLine: loc.startLine,
        startCharacter: loc.startCharacter,
        endLine: loc.endLine,
        endCharacter: loc.endCharacter,
      });
    }
    return out;
  }
}
