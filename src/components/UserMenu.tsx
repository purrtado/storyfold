import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Settings } from "lucide-react";
import { Link } from "react-router-dom";
import "./user-menu.css";

export function UserMenu({ compact = false }: { compact?: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`user-menu-trigger ${compact ? "user-menu-trigger--compact" : ""}`}
          aria-label="User menu"
        >
          <span className="user-avatar" aria-hidden="true">
            U
          </span>
          {!compact && <span>User</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="user-menu-content"
          side={compact ? "right" : "top"}
          align={compact ? "end" : "start"}
          sideOffset={8}
          collisionPadding={12}
        >
          <DropdownMenu.Item asChild>
            <Link to="/settings/general" className="user-menu-item">
              <Settings size={18} aria-hidden="true" />
              Settings
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
