/**
 * One place for localStorage access. Every store used to hand-roll its own
 * try/catch read + write (or, in theme.ts's case, forgot the try/catch on the
 * read — a single throw from a restricted storage context broke theme load
 * entirely). Centralized here so that mistake can't happen again per-store.
 */

/** Read + JSON.parse a value, falling back on ANY failure (missing key, corrupt JSON, storage unavailable/throwing). */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Write a value as JSON. Returns whether it succeeded, so callers that need
 * to revert an optimistic update (or warn the user) can check it; callers
 * that don't care can just ignore the return. */
export function saveJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Read a plain (non-JSON) string value, falling back on any failure. */
export function loadRaw(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Write a plain (non-JSON) string value. Returns whether it succeeded. */
export function saveRaw(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
