import { Link, NavLink } from "react-router-dom";
import { ArrowLeft, Monitor, Moon, Settings, Sun } from "lucide-react";
import type { ThemePreference } from "../lib/useTheme";
import { FoldIcon } from "./icons";
import "./settings.css";

const themeOptions = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

export function SettingsPage(props: {
  preference: ThemePreference;
  onPreferenceChange: (preference: ThemePreference) => void;
}) {
  return (
    <div className="settings">
      <header className="settings-side">
        <Link to="/" className="settings-brand" aria-label="Storyfold home">
          <FoldIcon className="settings-brand-icon" aria-hidden="true" />
          Storyfold
        </Link>
        <Link to="/" className="settings-back">
          <ArrowLeft className="settings-link-icon" aria-hidden="true" />
          Back to app
        </Link>
        <nav className="settings-nav" aria-label="Settings">
          <NavLink
            to="/settings/general"
            className={({ isActive }) =>
              isActive
                ? "settings-nav-link settings-nav-link--active"
                : "settings-nav-link"
            }
          >
            <Settings className="settings-link-icon" aria-hidden="true" />
            General
          </NavLink>
        </nav>
      </header>

      <main className="settings-main">
        <h1 className="settings-heading">General</h1>

        <fieldset className="theme-group">
          <legend className="sr-only">Theme</legend>
          <div className="theme-body">
            <div className="theme-copy">
              <p className="theme-label" aria-hidden="true">
                Theme
              </p>
              <p className="theme-desc">Choose how Storyfold looks.</p>
            </div>
            <div className="theme-segments">
              {themeOptions.map(({ value, label, Icon }) => (
                <label key={value} className="theme-segment pressable">
                  <input
                    className="theme-input"
                    type="radio"
                    name="theme"
                    value={value}
                    checked={props.preference === value}
                    onChange={() => props.onPreferenceChange(value)}
                  />
                  <Icon className="theme-seg-icon" aria-hidden="true" />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>
      </main>
    </div>
  );
}
