import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_THEME, STORAGE_KEY, SYSTEM_SYNC_KEY, THEMES, type ThemeId } from './themes';

function isValidTheme(id: string): id is ThemeId {
  return id in THEMES;
}

function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isValidTheme(stored)) return stored;
  } catch { /* ignore */ }
  return DEFAULT_THEME;
}

function readSystemSync(): boolean {
  try {
    return localStorage.getItem(SYSTEM_SYNC_KEY) === '1';
  } catch { /* ignore */ }
  return false;
}

function getSystemTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light-blue';
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme(id: ThemeId) {
  const tokens = THEMES[id];
  const root = document.documentElement;
  root.setAttribute('data-theme', id);
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value);
  }
  // Update color-scheme for native elements
  root.style.colorScheme = id === 'dark' ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);
  const [systemSync, setSystemSyncState] = useState(readSystemSync);
  const [ready, setReady] = useState(false);

  // Apply on mount and when theme changes
  useEffect(() => {
    const effective = systemSync ? getSystemTheme() : theme;
    applyTheme(effective);
    setReady(true);
  }, [theme, systemSync]);

  // Listen to system theme changes when sync is on
  useEffect(() => {
    if (!systemSync) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const next = getSystemTheme();
      applyTheme(next);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [systemSync]);

  const setTheme = useCallback((id: ThemeId) => {
    if (!isValidTheme(id)) return;
    setThemeState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch { /* ignore */ }
    // If system sync is on, turning it off is handled separately
  }, []);

  const setSystemSync = useCallback((on: boolean) => {
    setSystemSyncState(on);
    try {
      localStorage.setItem(SYSTEM_SYNC_KEY, on ? '1' : '0');
    } catch { /* ignore */ }
    if (!on) {
      // Restore last manual selection
      const last = readStoredTheme();
      setThemeState(last);
      applyTheme(last);
    } else {
      const sys = getSystemTheme();
      applyTheme(sys);
    }
  }, []);

  const effectiveTheme = systemSync ? getSystemTheme() : theme;

  return {
    theme,
    effectiveTheme,
    systemSync,
    setTheme,
    setSystemSync,
    ready,
  };
}
