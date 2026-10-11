import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "./icons";

type Theme = "light" | "dark";

const stored = (): Theme | null => {
  const value = localStorage.getItem("storyfold-theme");
  return value === "light" || value === "dark" ? value : null;
};

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("storyfold-theme", theme);
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")),
  };
}

export function ThemeButton(props: {
  theme: Theme;
  onClick: () => void;
  className?: string;
}) {
  const dark = props.theme === "dark";
  return (
    <button
      type="button"
      className={`pressable inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-foreground ${props.className ?? ""}`}
      onClick={props.onClick}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
