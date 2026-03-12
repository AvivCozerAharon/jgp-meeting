// hooks/useTheme.ts
// Gerencia o tema da interface (dark/light/system).
// Aplica a classe "dark" no <html> e persiste a preferência nas settings.

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "@/types";

type Theme = "dark" | "light" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  resolvedTheme: "dark",
  setTheme: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export { ThemeContext };
export type { Theme };

/** Resolve "system" para o tema real do OS */
function getSystemTheme(): "dark" | "light" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "dark";
}

/** Aplica ou remove a classe "dark" no <html> */
function applyThemeClass(resolved: "dark" | "light") {
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

/** Hook para usar no ThemeProvider */
export function useThemeProvider(): ThemeContextValue {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("dark");

  // Carrega tema das settings ao iniciar
  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((settings) => {
        const saved = (settings.theme || "dark") as Theme;
        setThemeState(saved);
        const resolved = saved === "system" ? getSystemTheme() : saved;
        setResolvedTheme(resolved);
        applyThemeClass(resolved);
      })
      .catch(() => {
        // Fallback: dark mode
        applyThemeClass("dark");
      });
  }, []);

  // Monitora mudanças no prefers-color-scheme (para tema "system")
  useEffect(() => {
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const resolved = e.matches ? "dark" : "light";
      setResolvedTheme(resolved);
      applyThemeClass(resolved);
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback(async (newTheme: Theme) => {
    setThemeState(newTheme);
    const resolved = newTheme === "system" ? getSystemTheme() : newTheme;
    setResolvedTheme(resolved);
    applyThemeClass(resolved);

    // Persiste nas settings
    try {
      const settings = await invoke<AppSettings>("get_settings");
      settings.theme = newTheme;
      await invoke("save_settings", { settings });
    } catch (e) {
      console.error("Erro ao salvar tema:", e);
    }
  }, []);

  return { theme, resolvedTheme, setTheme };
}
