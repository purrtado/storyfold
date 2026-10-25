import { useId, useState, type ComponentType, type SVGProps } from "react";
import { motion, useReducedMotion } from "motion/react";
import { SPRING_LAYOUT } from "../lib/ease";
import { Link, NavLink } from "react-router-dom";
import { ArrowLeft, Ellipsis, Gauge, KeyRound, MessageSquareText, Monitor, Moon, Pencil, Settings, Sun } from "lucide-react";
import type { ThemePreference } from "../lib/useTheme";
import { storeMessageControls, storedMessageControls, type MessageControls } from "../lib/messageControls";
import { AppHeader } from "./AppHeader";
import { RailExpand, SidebarBrand } from "./Sidebar";
import { Tooltip } from "./Tooltip";
import { UserMenu } from "./UserMenu";
import "./settings.css";

type SegmentOption<T extends string> = { value: T; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> };

const themeOptions: SegmentOption<ThemePreference>[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

const messageControlOptions: SegmentOption<MessageControls>[] = [
  { value: "menu", label: "Menu", Icon: Ellipsis },
  { value: "inline", label: "Icons", Icon: Pencil },
];

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

function SegmentedSetting<T extends string>(props: {
  name: string;
  label: string;
  description: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const indicatorId = useId();
  const reducedMotion = useReducedMotion();

  return (
    <fieldset className="theme-group">
      <legend className="sr-only">{props.label}</legend>
      <div className="theme-body">
        <div className="theme-copy">
          <p className="theme-label" aria-hidden="true">
            {props.label}
          </p>
          <p className="theme-desc">{props.description}</p>
        </div>
        <motion.div layoutRoot className="theme-segments">
          {props.options.map(({ value, label, Icon }) => (
            <label key={value} className="theme-segment">
              {props.value === value &&
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
                name={props.name}
                value={value}
                checked={props.value === value}
                onChange={() => props.onChange(value)}
              />
              <Icon className="theme-seg-icon" aria-hidden="true" />
              <span>{label}</span>
            </label>
          ))}
        </motion.div>
      </div>
    </fieldset>
  );
}

export function SettingsPage(props: {
  preference: ThemePreference;
  onPreferenceChange: (preference: ThemePreference) => void;
  onOpenSidebar: () => void;
}) {
  const [messageControls, setMessageControls] = useState(storedMessageControls);

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="Settings" onOpenSidebar={props.onOpenSidebar} />

      <div className="chat-scroll settings-scroll">
        <main className="settings-main">
          <h2 className="settings-heading">General</h2>

          <SegmentedSetting
            name="theme"
            label="Theme"
            description="Choose how Storyfold looks."
            options={themeOptions}
            value={props.preference}
            onChange={props.onPreferenceChange}
          />
          <SegmentedSetting
            name="message-controls"
            label="Message controls"
            description="Show message actions in a ⋯ menu or as icons under each message."
            options={messageControlOptions}
            value={messageControls}
            onChange={(value) => {
              storeMessageControls(value);
              setMessageControls(value);
            }}
          />
        </main>
      </div>
    </div>
  );
}
