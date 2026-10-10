import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = "system" | Theme;

const storageKey = "storyfold-theme";

function storedPreference(): ThemePreference {
  const value = localStorage.getItem(storageKey);
  return value === "system" || value === "light" || value === "dark"
    ? value
    : "system";
}

function resolveTheme(
  preference: ThemePreference,
  systemDark?: boolean,
): Theme {
  if (preference !== "system") return preference;
  return (systemDark ??
    window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
}

export function useTheme() {
  const [preference, setPreference] =
    useState<ThemePreference>(storedPreference);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(preference));

  useEffect(() => {
    const media =
      preference === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : undefined;
    const apply = () => {
      const resolved = resolveTheme(preference, media?.matches);
      document.documentElement.dataset.theme = resolved;
      localStorage.setItem(storageKey, preference);
      setTheme(resolved);
    };

    apply();
    if (!media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  return { theme, preference, setPreference };
}
