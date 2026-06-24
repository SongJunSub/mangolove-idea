import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileReadResult } from '../../shared/types';

/** Drives the A4 editor for ONE (worktree, file). null worktree/file => idle. */
export interface UseFileEditor {
  /** Baseline (last loaded/saved) text; null while loading (a blank, not the file). */
  readonly content: string | null;
  /** Live editor buffer. */
  readonly value: string;
  /** Unsaved edits exist (false for readOnly / loading / failed-load). */
  readonly dirty: boolean;
  /** Why the file is view-only, if it is. */
  readonly reason?: FileReadResult['reason'];
  readonly readOnly: boolean;
  readonly loadError: string | null;
  readonly saveError: string | null;
  readonly saving: boolean;
  setValue(v: string): void;
  /** Persists the buffer. Returns true on success (or no-op); false keeps it dirty. */
  save(): Promise<boolean>;
}

/** Collision-free identity for a (worktree,file) pair — the race-guard key. */
const keyFor = (worktreeId: string | null, relPath: string | null): string =>
  JSON.stringify([worktreeId, relPath]);

/**
 * Loads a worktree file as editable text and tracks dirty/save state. Mirrors
 * use-conflicts' race guard: a captured (worktree,file) KEY plus an aliveRef, so a slow
 * read for file A never clobbers file B's state, and nothing setState's after unmount.
 *
 * DATA-LOSS contract: dirty is cleared ONLY after a write IPC resolves ok. A failed
 * write keeps content (=> still dirty), keeps the buffer, and surfaces saveError — the
 * unsaved-guard then still prompts, so edits are never silently dropped.
 */
export function useFileEditor(worktreeId: string | null, relPath: string | null): UseFileEditor {
  const [content, setContent] = useState<string | null>(null);
  const [value, setValue] = useState<string>('');
  const [readOnly, setReadOnly] = useState<boolean>(false);
  const [reason, setReason] = useState<FileReadResult['reason']>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const baseTokenRef = useRef<string | undefined>(undefined);

  const aliveRef = useRef<boolean>(true);
  const keyRef = useRef<string>('');
  keyRef.current = keyFor(worktreeId, relPath);

  useEffect(() => {
    aliveRef.current = true;
    const requested = keyFor(worktreeId, relPath);
    const isFresh = (): boolean => aliveRef.current && keyRef.current === requested;
    // Reset to the loading baseline on every (worktree,file) change.
    setContent(null);
    setValue('');
    setReadOnly(false);
    setReason(undefined);
    setLoadError(null);
    setSaveError(null);
    baseTokenRef.current = undefined;

    if (worktreeId && relPath) {
      window.mango.file
        .read({ worktreeId, relPath })
        .then((res) => {
          if (!isFresh()) return;
          baseTokenRef.current = res.baseToken;
          setReadOnly(res.readOnly);
          setReason(res.reason);
          setContent(res.content);
          setValue(res.content);
        })
        .catch((e: unknown) => {
          if (!isFresh()) return;
          setLoadError(e instanceof Error ? e.message : String(e));
        });
    }
    return () => {
      aliveRef.current = false;
    };
  }, [worktreeId, relPath]);

  const dirty = !readOnly && content !== null && value !== content;

  const save = useCallback(async (): Promise<boolean> => {
    if (!worktreeId || !relPath || readOnly || content === null) return true;
    if (value === content) return true; // nothing to persist
    const requested = keyFor(worktreeId, relPath);
    const isFresh = (): boolean => aliveRef.current && keyRef.current === requested;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await window.mango.file.write({
        worktreeId,
        relPath,
        content: value,
        baseToken: baseTokenRef.current,
      });
      if (!isFresh()) return res.ok; // switched files mid-save: don't touch the new file's state
      if (res.ok) {
        baseTokenRef.current = res.baseToken ?? baseTokenRef.current;
        setContent(value); // content===value => dirty clears (new edits during await re-dirty)
        return true;
      }
      setSaveError(res.error ?? 'failed to write file'); // keep content => still dirty
      return false;
    } catch (e) {
      if (isFresh()) setSaveError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (isFresh()) setSaving(false);
    }
  }, [worktreeId, relPath, readOnly, content, value]);

  return { content, value, dirty, reason, readOnly, loadError, saveError, saving, setValue, save };
}
