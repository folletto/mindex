/**
 * Shared renderer state: which library is open, and when its data last moved.
 *
 * The "data changed" signal covers both this window's own writes and another
 * machine's commits — from here they are the same event, and the answer to both
 * is to re-read.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FieldDef, LibraryState } from '@shared/types';
import { api } from './api.js';

export function useLibraryState(): { state: LibraryState | null; refresh: () => void } {
  const [state, setState] = useState<LibraryState | null>(null);

  const refresh = useCallback(() => {
    void api.library.getState().then(setState);
  }, []);

  useEffect(() => {
    refresh();
    return api.library.onChanged(setState);
  }, [refresh]);

  return { state, refresh };
}

/** A monotonic counter that ticks whenever anything in the library changes. */
export function useDataVersion(): number {
  const [version, setVersion] = useState(0);

  useEffect(() => api.library.onDataChanged(() => setVersion((current) => current + 1)), []);

  return version;
}

export function useFields(dataVersion: number): FieldDef[] {
  const [fields, setFields] = useState<FieldDef[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.fields.list().then((next) => {
      if (!cancelled) setFields(next);
    });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  return fields;
}

/** Debounce a fast-changing value — the search box, in practice. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
