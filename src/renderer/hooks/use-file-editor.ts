import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileReadResult } from '../../shared/types';

/** Drives the A4 editor for ONE (worktree, file). null worktree/file => idle. */
export interface UseFileEditor {
  /** Baseline (last loaded/saved) text; null while loading (a blank, not the file). */
  readonly content: string | null;
  /** Live editor buffer. */
  readonly value: string;
  /** Unsaved edits exist (false for readOnly / loading / failed-load). Transient under
   *  auto-save: true only during the debounce window or after a failed write. */
  readonly dirty: boolean;
  /** Why the file is view-only, if it is. */
  readonly reason?: FileReadResult['reason'];
  readonly readOnly: boolean;
  readonly loadError: string | null;
  readonly saveError: string | null;
  readonly saving: boolean;
  setValue(v: string): void;
  /** Persists the buffer NOW (Cmd+S / editor blur / file-or-worktree switch / quit). Returns
   *  true on success (or no-op); false keeps it dirty. Cancels any pending debounced write. */
  flush(): Promise<boolean>;
}

/** Debounce for auto-save: a burst of keystrokes persists once, after this idle gap. */
const AUTOSAVE_DELAY_MS = 400;

/** Collision-free identity for a (worktree,file) pair — the race-guard key. */
const keyFor = (worktreeId: string | null, relPath: string | null): string =>
  JSON.stringify([worktreeId, relPath]);

/**
 * Loads a worktree file as editable text and AUTO-SAVES it (debounced). Mirrors use-conflicts'
 * race guard: a captured (worktree,file) KEY plus an aliveRef, so a slow read for file A never
 * clobbers file B's state, and nothing setState's after unmount.
 *
 * DATA-LOSS contract: dirty is cleared ONLY after a write IPC resolves ok. A failed write keeps
 * content (=> still dirty), keeps the buffer, and surfaces saveError. Writes are SERIALIZED — a
 * second write never races the first's baseToken; an edit that lands mid-write is coalesced and
 * re-flushed when the in-flight write settles. Every write captures its (worktree,file,baseToken)
 * up front, so a switch that fires during the await persists the OUTGOING file, never the new one.
 */
export function useFileEditor(worktreeId: string | null, relPath: string | null): UseFileEditor {
  const [content, setContent] = useState<string | null>(null);
  const [value, setValueState] = useState<string>('');
  const [readOnly, setReadOnly] = useState<boolean>(false);
  const [reason, setReason] = useState<FileReadResult['reason']>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const baseTokenRef = useRef<string | undefined>(undefined);

  const aliveRef = useRef<boolean>(true);
  const keyRef = useRef<string>('');
  keyRef.current = keyFor(worktreeId, relPath);

  // Latest buffer/baseline/readOnly read by the writer WITHOUT being effect deps (so a write
  // captured for the outgoing file always sees that file's values, never the switched-in one).
  const valueRef = useRef<string>('');
  valueRef.current = value;
  // Synchronous mirror of the on-disk content (null while loading). The `content` React state
  // lags a render, so the writer keys its clean/dirty decision on this instead — updated the
  // instant a read/write settles, which is what prevents a drained flush from re-writing.
  const lastSavedRef = useRef<string | null>(null);
  const readOnlyRef = useRef<boolean>(false);
  readOnlyRef.current = readOnly;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null); // the current write IPC, if running

  const clearTimer = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * Persists the CURRENT buffer, SERIALIZED: awaits any in-flight write, then writes the latest
   * buffer, then repeats until the buffer matches the baseline. So the returned promise resolves
   * ONLY once the current buffer is durably on disk (true) or a write failed (false) — never on a
   * mere coalesce. Callers that await it before a switch can trust the outgoing file is saved.
   * Each write captures its (worktree,file,baseToken) up front + guards state with isFresh, so a
   * write that settles after a switch persists the OUTGOING file without touching the new one.
   */
  const writeNow = useCallback(async (): Promise<boolean> => {
    const prev = inFlightRef.current;
    if (prev) {
      await prev.catch(() => undefined); // wait for the in-flight write, then re-evaluate
      return writeNow();
    }
    const wt = worktreeId;
    const rel = relPath;
    if (!wt || !rel || readOnlyRef.current || lastSavedRef.current === null) return true;
    if (valueRef.current === lastSavedRef.current) return true; // nothing to persist
    const requested = keyFor(wt, rel);
    const isFresh = (): boolean => aliveRef.current && keyRef.current === requested;
    const outgoing = valueRef.current;
    const token = baseTokenRef.current;
    const run = (async (): Promise<boolean> => {
      if (isFresh()) {
        setSaving(true);
        setSaveError(null);
      }
      try {
        const res = await window.mango.file.write({
          worktreeId: wt,
          relPath: rel,
          content: outgoing,
          baseToken: token,
        });
        if (res.ok) {
          // Only touch state/baseline while still on this file: a stale write (we switched away)
          // must NOT overwrite the new file's baseToken or clear its dirty flag.
          if (isFresh()) {
            baseTokenRef.current = res.baseToken ?? baseTokenRef.current;
            lastSavedRef.current = outgoing; // synchronous: a drained flush now no-ops
            setContent(outgoing); // content===value => dirty clears
          }
          return true;
        }
        if (isFresh()) setSaveError(res.error ?? 'failed to write file'); // keep content => dirty
        return false;
      } catch (e) {
        if (isFresh()) setSaveError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        if (isFresh()) setSaving(false);
      }
    })();
    inFlightRef.current = run;
    let ok: boolean;
    try {
      ok = await run;
    } finally {
      inFlightRef.current = null;
    }
    // Persist edits that landed while this write was in flight (latest buffer wins), so an awaited
    // flush never resolves with unwritten keystrokes still buffered. Compare against the LOCAL
    // `outgoing` we just wrote — NOT contentRef, which lags until the setContent render commits and
    // would otherwise re-trigger forever.
    if (ok && isFresh() && valueRef.current !== outgoing) return writeNow();
    return ok;
  }, [worktreeId, relPath]);

  useEffect(() => {
    aliveRef.current = true;
    const requested = keyFor(worktreeId, relPath);
    const isFresh = (): boolean => aliveRef.current && keyRef.current === requested;
    // Reset to the loading baseline on every (worktree,file) change.
    setContent(null);
    setValueState('');
    setReadOnly(false);
    setReason(undefined);
    setLoadError(null);
    setSaveError(null);
    baseTokenRef.current = undefined;
    lastSavedRef.current = null; // loading: nothing on disk to compare against yet

    if (worktreeId && relPath) {
      window.mango.file
        .read({ worktreeId, relPath })
        .then((res) => {
          if (!isFresh()) return;
          baseTokenRef.current = res.baseToken;
          lastSavedRef.current = res.content;
          setReadOnly(res.readOnly);
          setReason(res.reason);
          setContent(res.content);
          setValueState(res.content);
        })
        .catch((e: unknown) => {
          if (!isFresh()) return;
          setLoadError(e instanceof Error ? e.message : String(e));
        });
    }
    return () => {
      aliveRef.current = false;
      clearTimer(); // drop the outgoing file's pending debounced write (also runs on unmount)
    };
  }, [worktreeId, relPath, clearTimer]);

  const dirty = !readOnly && content !== null && value !== content;

  /** Buffer a keystroke and (re)arm the debounced auto-save. */
  const setValue = useCallback(
    (v: string): void => {
      setValueState(v);
      if (readOnlyRef.current) return;
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void writeNow();
      }, AUTOSAVE_DELAY_MS);
    },
    [clearTimer, writeNow],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimer();
    return writeNow();
  }, [clearTimer, writeNow]);

  return { content, value, dirty, reason, readOnly, loadError, saveError, saving, setValue, flush };
}
