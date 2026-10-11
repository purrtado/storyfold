import { useEffect, useState, type ChangeEvent } from "react";
import { MoonIcon, SunIcon } from "./icons";
import { Tooltip } from "./Tooltip";

export type Theme = "light" | "dark";
export type ThemePreference = "system" | Theme;

const storageKey = "storyfold-theme";

function storedPreference(): ThemePreference {
  const value = localStorage.getItem(storageKey);
  return value === "system" || value === "light" || value === "dark"
    ? value
    : "system";
}

function resolveTheme(preference: ThemePreference, systemDark?: boolean): Theme {
  if (preference !== "system") return preference;
  return (systemDark ?? window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(preference));

  useEffect(() => {
    const media = preference === "system"
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

export function ThemeButton(props: {
  preference: ThemePreference;
  onPreferenceChange: (preference: ThemePreference) => void;
  className?: string;
  compact?: boolean;
}) {
  const options = (
    <>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </>
  );
  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    props.onPreferenceChange(event.currentTarget.value as ThemePreference);
  };
  const preferenceLabel = {
    system: "System",
    light: "Light",
    dark: "Dark",
  }[props.preference];
  if (props.compact) {
    return (
      <span className={`pressable relative inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${props.className ?? ""}`}>
        <span aria-hidden="true" className="pointer-events-none inline-flex size-4 items-center justify-center">
          {props.preference === "system" ? (
            <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="13" rx="2" />
              <path d="M8 21h8m-4-4v4" />
            </svg>
          ) : props.preference === "dark" ? (
            <MoonIcon />
          ) : (
            <SunIcon />
          )}
        </span>
        <Tooltip
          content={`Theme preference: ${preferenceLabel}`}
          side="right"
          wrapperClassName="absolute inset-0"
        >
          <select
            aria-label="Theme preference"
            className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
            onChange={onChange}
            value={props.preference}
          >
            {options}
          </select>
        </Tooltip>
      </span>
    );
  }

  return (
    <select
      aria-label="Theme preference"
      className={`pressable h-9 max-w-full cursor-pointer rounded-lg border border-border bg-transparent px-2.5 text-sm text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface ${props.className ?? ""}`}
      onChange={onChange}
      value={props.preference}
    >
      {options}
    </select>
  );
}
