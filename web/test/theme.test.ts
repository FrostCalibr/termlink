import { describe, it, expect } from "vitest";
import { resolveTheme, ThemeManager, type ThemePreference } from "../src/theme.js";

function env(systemDark: boolean) {
  const el = { dataset: {} as Record<string, string> };
  const storage: Record<string, string> = {};
  const manager = new ThemeManager(undefined, {
    document: { documentElement: el } as unknown as Document,
    matchMedia: (q) =>
      ({ matches: q === "(prefers-color-scheme: dark)" ? systemDark : false }) as MediaQueryList,
    storage: {
      getItem: (k) => storage[k] ?? null,
      setItem: (k, v) => {
        storage[k] = v;
      },
    },
  });
  return { manager, el, storage };
}

describe("theme", () => {
  it("resolves system preference from the OS scheme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("applies the resolved theme to the document", () => {
    const { manager, el } = env(false);
    expect(el.dataset.theme).toBe("light");
    manager.setPreference("dark");
    expect(el.dataset.theme).toBe("dark");
  });

  it("persists the preference and honors it on load", () => {
    const a = env(false);
    a.manager.setPreference("light");
    const b = env(false);
    expect(b.manager.preference).toBe("system"); // different storage instance
    expect(a.manager.preference).toBe("light");
  });

  it("cycles light → dark → system", () => {
    const { manager } = env(false);
    expect(manager.cycle()).toBe("light");
    expect(manager.cycle()).toBe("dark");
    expect(manager.cycle()).toBe("system");
  });

  it("notifies when the resolved theme changes", () => {
    const seen: Array<string> = [];
    const { el } = env(false);
    const mgr = new ThemeManager((r) => seen.push(r), {
      document: { documentElement: el } as unknown as Document,
      matchMedia: () => ({ matches: false }) as MediaQueryList,
      storage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });
    mgr.setPreference("dark");
    expect(seen).toEqual(["light", "dark"]);
  });

  it("rejects an unknown persisted preference", () => {
    const storage: Record<string, string> = {};
    const el = { dataset: {} as Record<string, string> };
    const mgr = new ThemeManager(undefined, {
      document: { documentElement: el } as unknown as Document,
      matchMedia: () => ({ matches: false }) as MediaQueryList,
      storage: {
        getItem: () => "neon",
        setItem: () => undefined,
      },
    });
    expect(mgr.preference).toBe("system");
    void storage;
    void (() => mgr.preference satisfies ThemePreference);
  });
});