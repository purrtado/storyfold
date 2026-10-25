import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { SPRING_LAYOUT } from "../lib/ease";
import { Link, NavLink } from "react-router-dom";
import { ArrowLeft, Gauge, KeyRound, MessageSquareText, Monitor, Moon, Settings, Sun } from "lucide-react";
import type { ThemePreference } from "../lib/useTheme";
import { AppHeader } from "./AppHeader";
import { RailExpand, SidebarBrand } from "./Sidebar";
import { Tooltip } from "./Tooltip";
import { UserMenu } from "./UserMenu";
import "./settings.css";

const themeOptions = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

const navRow =
  "pressable flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm no-underline active:bg-raised";
const navRowActive = `${navRow} bg-accent-soft font-medium text-foreground`;
const navRowInactive = `${navRow} text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground`;

export function SettingsSidebar(props: {
  variant?: "full" | "rail";
  onCollapse?: () => void;
}) {
  if (props.variant === "rail") {
    return (
      <div className="flex h-full [inline-size:3.5rem] flex-col items-center gap-1 py-3">
        <RailExpand onCollapse={props.onCollapse} />

        <Tooltip content="Back to app" side="right">
          <Link to="/" className="rail-btn" aria-label="Back to app">
            <ArrowLeft className="size-4.5" aria-hidden="true" />
          </Link>
        </Tooltip>

        <Tooltip content="General" side="right">
          <NavLink
            to="/settings/general"
            className={({ isActive }) =>
              isActive ? "rail-btn rail-btn--active" : "rail-btn"
            }
            aria-label="General"
          >
            <Settings className="size-4.5" aria-hidden="true" />
          </NavLink>
        </Tooltip>

        <Tooltip content="Providers" side="right">
          <NavLink
            to="/settings/providers"
            className={({ isActive }) =>
              isActive ? "rail-btn rail-btn--active" : "rail-btn"
            }
            aria-label="Providers"
          >
            <KeyRound className="size-4.5" aria-hidden="true" />
          </NavLink>
        </Tooltip>

        <Tooltip content="Stats" side="right">
          <NavLink
            to="/settings/stats"
            className={({ isActive }) =>
              isActive ? "rail-btn rail-btn--active" : "rail-btn"
            }
            aria-label="Stats"
          >
            <Gauge className="size-4.5" aria-hidden="true" />
          </NavLink>
        </Tooltip>

        <Tooltip content="Prompt" side="right">
          <NavLink
            to="/settings/prompt"
            className={({ isActive }) =>
              isActive ? "rail-btn rail-btn--active" : "rail-btn"
            }
            aria-label="Prompt"
          >
            <MessageSquareText className="size-4.5" aria-hidden="true" />
          </NavLink>
        </Tooltip>

        <div className="[margin-block-start:auto]">
          <UserMenu compact />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <SidebarBrand onCollapse={props.onCollapse} />

      <nav aria-label="Settings" className="flex flex-col gap-0.5">
        <Link to="/" className={navRowInactive}>
          <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
          Back to app
        </Link>
        <NavLink
          to="/settings/general"
          className={({ isActive }) => (isActive ? navRowActive : navRowInactive)}
        >
          <Settings className="size-4 shrink-0" aria-hidden="true" />
          General
        </NavLink>
        <NavLink
          to="/settings/providers"
          className={({ isActive }) => (isActive ? navRowActive : navRowInactive)}
        >
          <KeyRound className="size-4 shrink-0" aria-hidden="true" />
          Providers
        </NavLink>
        <NavLink
          to="/settings/stats"
          className={({ isActive }) => (isActive ? navRowActive : navRowInactive)}
        >
          <Gauge className="size-4 shrink-0" aria-hidden="true" />
          Stats
        </NavLink>
        <NavLink
          to="/settings/prompt"
          className={({ isActive }) => (isActive ? navRowActive : navRowInactive)}
        >
          <MessageSquareText className="size-4 shrink-0" aria-hidden="true" />
          Prompt
        </NavLink>
      </nav>

      <div className="[margin-block-start:auto]">
        <UserMenu />
      </div>
    </div>
  );
}

export function SettingsPage(props: {
  preference: ThemePreference;
  onPreferenceChange: (preference: ThemePreference) => void;
  onOpenSidebar: () => void;
}) {
  const indicatorId = useId();
  const reducedMotion = useReducedMotion();

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="Settings" onOpenSidebar={props.onOpenSidebar} />

      <div className="chat-scroll settings-scroll">
        <main className="settings-main">
          <h2 className="settings-heading">General</h2>

          <fieldset className="theme-group">
            <legend className="sr-only">Theme</legend>
            <div className="theme-body">
              <div className="theme-copy">
                <p className="theme-label" aria-hidden="true">
                  Theme
                </p>
                <p className="theme-desc">Choose how Storyfold looks.</p>
              </div>
              <motion.div layoutRoot className="theme-segments">
                {themeOptions.map(({ value, label, Icon }) => (
                  <label key={value} className="theme-segment">
                    {props.preference === value &&
                      (reducedMotion ? (
                        <span className="theme-indicator" aria-hidden="true" />
                      ) : (
                        <motion.span
                          className="theme-indicator"
                          aria-hidden="true"
                          layoutId={indicatorId}
                          transition={SPRING_LAYOUT}
                          style={{ borderRadius: 9999 }}
                        />
                      ))}
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
              </motion.div>
            </div>
          </fieldset>
        </main>
      </div>
    </div>
  );
}
