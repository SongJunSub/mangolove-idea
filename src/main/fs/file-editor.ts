import { join } from 'node:path';
import type { FileReadRequest, FileReadResult, FileWriteRequest } from '../../shared/types';
import {
  resolveExistingScopedPath,
  resolveWritableScopedPath,
  type ScopeDeps,
} from './scoped-path';

/**
 * Reads + writes ONE file inside a worktree for the A4 editor. Every path goes through
 * the shared scoped-path gate (no raw fs path the renderer controls ever reaches fs).
 *
 * READ refuses to hand back anything that cannot round-trip losslessly as UTF-8 text:
 *  - too large (> MAX_BYTES), binary (a NUL byte), or not valid UTF-8 → readOnly, so
 *    Save can never re-encode-and-corrupt the original bytes.
 * WRITE is hostile-renderer safe: it caps content size independently (the renderer can
 * send arbitrary content regardless of what was read), checks an optimistic-concurrency
 * token, and delegates the actual write to an O_NOFOLLOW seam (writeNoFollow) so a
 * symlink at the final component cannot be written THROUGH.
 */

/** Hard cap for both read and write (5 MiB). Monaco is unusable past this anyway. */
export const MAX_BYTES = 5 * 1024 * 1024;

/** Minimal stat slice the editor needs (node:fs.Stats satisfies it structurally). */
export interface StatLike {
  isFile(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface FileEditorDeps extends ScopeDeps {
  /** stat the CANONICAL (already realpath'd) path — size/mtime/isFile. */
  readonly statSync: (p: string) => StatLike;
  /** Read the whole file as bytes (canonical path). */
  readonly readFileSync: (p: string) => Buffer;
  /**
   * Write `content` (utf-8) to `parentReal`/`name`, opening the FINAL component with
   * O_NOFOLLOW so a symlink there throws (never written through). MUST fstat the fd and
   * refuse a non-regular file. Wired in register-ipc with node:fs.
   */
  readonly writeNoFollow: (parentReal: string, name: string, content: string) => void;
}

/** Optimistic-concurrency token: changes whenever the file's size or mtime changes. */
const tokenOf = (st: StatLike): string => `${st.mtimeMs}:${st.size}`;

/** True if the buffer looks binary: a NUL byte in the first 8 KiB. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export class FileEditor {
  constructor(private readonly deps: FileEditorDeps) {}

  /** Reads a file as editable UTF-8 text, or returns a readOnly view for binary/large/non-utf8. */
  async read(req: FileReadRequest): Promise<FileReadResult> {
    const { targetReal } = await resolveExistingScopedPath(this.deps, req.worktreeId, req.relPath);
    const st = this.deps.statSync(targetReal);
    if (!st.isFile()) throw new Error('not a file');
    const baseToken = tokenOf(st);

    if (st.size > MAX_BYTES) {
      return { content: '', readOnly: true, reason: 'tooLarge', size: st.size, baseToken };
    }
    const buf = this.deps.readFileSync(targetReal);
    if (looksBinary(buf)) {
      return { content: '', readOnly: true, reason: 'binary', size: st.size, baseToken };
    }
    let content: string;
    try {
      // fatal => throw on any invalid byte (latin-1/UTF-16-without-NUL never become
      // U+FFFD here). ignoreBOM keeps a UTF-8 BOM in the string so it round-trips.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      return { content: '', readOnly: true, reason: 'encoding', size: st.size, baseToken };
    }
    // Belt-and-suspenders: the write path can only ever round-trip bytes that survive
    // utf-8 losslessly. If re-encoding isn't byte-identical, refuse (view-only).
    if (!Buffer.from(content, 'utf8').equals(buf)) {
      return { content: '', readOnly: true, reason: 'encoding', size: st.size, baseToken };
    }
    return { content, readOnly: false, size: st.size, baseToken };
  }

  /**
   * Writes text to a file. Returns a FRESH baseToken so the renderer's next save uses an
   * up-to-date optimistic token (otherwise the token we just invalidated would false-
   * positive as a conflict on the very next save). Throws on size cap, an out-of-tree
   * escape, or a concurrent on-disk change.
   */
  async write(req: FileWriteRequest): Promise<{ baseToken: string }> {
    const { worktreeId, relPath, content, baseToken } = req;
    // Independent cap on the WRITE path: a hostile renderer can send any content,
    // regardless of what read() returned.
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      throw new Error('file too large to write');
    }
    const { parentReal, name, existed } = await resolveWritableScopedPath(
      this.deps,
      worktreeId,
      relPath,
    );
    const canonical = join(parentReal, name);
    // Optimistic concurrency: if the caller carried a token AND the file already exists,
    // refuse when it changed under us (another process / the agent edited it).
    if (existed && baseToken != null) {
      const cur = this.deps.statSync(canonical);
      if (tokenOf(cur) !== baseToken) {
        throw new Error('file changed on disk since it was opened — reload before saving');
      }
    }
    this.deps.writeNoFollow(parentReal, name, content);
    return { baseToken: tokenOf(this.deps.statSync(canonical)) };
  }
}
