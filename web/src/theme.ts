/**
 * Theme support: dark / light / system. The pure helpers are DOM-free so they
 * are unit-testable; {@link ThemeManager} applies the resolved theme to
 * `document.documentElement.dataset.theme` which the stylesheet consumes.
 */

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_PREFERENCE_KEY = "termlink.theme";

export function detectSystemTheme(systemDark: boolean): ResolvedTheme {
  return systemDark ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system" || preference === undefined) {
    return detectSystemTheme(systemDark);
  }
  return preference;
}

export interface ThemeEnvironment {
  document?: Document;
  matchMedia?: (query: string) => { matches: boolean };
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export class ThemeManager {
  preference: ThemePreference = "system";
  resolved: ResolvedTheme = "light";
  private document: Document | null;
  private matchMedia: ThemeEnvironment["matchMedia"];
  private storage: Pick<Storage, "getItem" | "setItem">;

  constructor(private onChange?: (resolved: ResolvedTheme) => void, env: ThemeEnvironment = {}) {
    this.document = env.document ?? (typeof document !== "undefined" ? document : null);
    this.matchMedia = env.matchMedia;
    this.storage = env.storage ?? safeStorage();
    const saved = this.storage.getItem(THEME_PREFERENCE_KEY);
    if (saved === "dark" || saved === "light" || saved === "system") {
      this.preference = saved;
    }
    this.apply(this.preference);
  }

  setPreference(preference: ThemePreference): void {
    this.preference = preference;
    this.storage.setItem(THEME_PREFERENCE_KEY, preference);
    this.apply(preference);
  }

  cycle(): ThemePreference {
    const order: ThemePreference[] = ["light", "dark", "system"];
    const current = order.indexOf(this.preference);
    const next = order[(current + 1) % order.length];
    this.setPreference(next);
    return next;
  }

  private apply(preference: ThemePreference): void {
    const systemDark = this.isSystemDark();
    const resolved = resolveTheme(preference, systemDark);
    if (this.document?.documentElement) {
      this.document.documentElement.dataset.theme = resolved;
    }
    this.resolved = resolved;
    this.onChange?.(resolved);
  }

  private isSystemDark(): boolean {
    if (this.matchMedia) return this.matchMedia("(prefers-color-scheme: dark)").matches;
    return false;
  }
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> {
  try {
    const s = globalThis.localStorage;
    if (s) return s;
  } catch {
    /* unavailable */
  }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => {
      mem.set(k, v);
    },
  };
}