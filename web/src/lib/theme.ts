import { useSyncExternalStore } from 'react';

/** The user's choice: a fixed theme, or follow the operating system. */
export type ThemePref = 'dark' | 'light' | 'system';
export const themePrefs: ThemePref[] = ['light', 'dark', 'system'];

const KEY = 'restream.theme';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set<() => void>();

function stored(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch { /* storage unavailable */ }
  return 'dark';
}

let pref: ThemePref = stored();

function resolved(p: ThemePref): 'dark' | 'light' {
  return p === 'system' ? (media?.matches ? 'light' : 'dark') : p;
}

function apply() {
  const t = resolved(pref);
  const root = document.documentElement;
  if (t === 'light') root.dataset.theme = 'light'; else delete root.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#F3F5F9' : '#070A12');
  listeners.forEach((l) => l());
}

media?.addEventListener('change', () => { if (pref === 'system') apply(); });
apply();

/** Applies a theme choice now and remembers it in this browser (the server copy is saved separately). */
export function setTheme(p: ThemePref) {
  pref = p;
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
  apply();
}

export function getTheme() { return pref; }

/** The current choice, re-rendering when it changes. */
export function useTheme(): ThemePref {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => pref);
}
