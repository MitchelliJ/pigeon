import type { JSX } from "solid-js";
import type { Category, ChannelKind, Provider } from "@pigeon/shared";

/* --------------------------------------------------------------- icons */

export function PlusIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M6 1.5v9M1.5 6h9"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** Sparkles glyph that prefixes every AI summary. */
export function SparklesIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 0.8l1.5 4.2L13.7 6 9.5 7.5 8 11.7 6.5 7.5 2.3 6 6.5 4.5 8 0.8z"
        fill="currentColor"
      />
      <path
        d="M13 9.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z"
        fill="currentColor"
        opacity="0.75"
      />
    </svg>
  );
}

export function SearchIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="4.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      />
      <path
        d="M10.5 10.5L14 14"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function GearIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function CalendarIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
      <rect
        x="2.5"
        y="3.5"
        width="13"
        height="12"
        rx="2"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <path
        d="M2.5 7.2h13M6 1.8v3M12 1.8v3"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function MoonIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M15 10.6A6.5 6.5 0 0 1 7.4 3 6.5 6.5 0 1 0 15 10.6z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function SendIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M17.5 2.5 9 11M17.5 2.5 12 17.5 9 11 2.5 8z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function ZapIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M11 1.8 3.6 11h4.9l-1.5 7.2L16.4 9h-4.9z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function ArrowUpRightIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M3.5 8.5 8.5 3.5M4 3.5h4.5V8"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function HelpIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="7" />
      <path
        d="M7 7a2 2 0 1 1 2.6 1.9c-.5.2-.6.5-.6 1V11"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="9" cy="13.4" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function LogOutIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M7 2.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 15.5h3" />
      <path d="M11.5 12.5 15 9l-3.5-3.5M15 9H6.5" />
    </svg>
  );
}

export function CloseIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M2 2l10 10M12 2L2 12"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}

/* --------------------------------------------------------------- providers */

export function providerVisual(provider: Provider): {
  bg: string;
  initials: string;
} {
  switch (provider) {
    case "gmail":
      return { bg: "#e2604f", initials: "G" };
    case "outlook":
      return { bg: "#2f6fd0", initials: "O" };
    case "icloud":
      return { bg: "#5fb0e8", initials: "iC" };
    case "fastmail":
      return { bg: "#3f7d6e", initials: "F" };
    case "mock":
      return { bg: "#7c9a6b", initials: "🕊" };
    default:
      return { bg: "#8a7d70", initials: "@" };
  }
}

export function providerName(provider: Provider): string {
  const names: Record<Provider, string> = {
    gmail: "Gmail",
    outlook: "Outlook",
    icloud: "iCloud Mail",
    fastmail: "Fastmail",
    imap: "IMAP",
    mock: "Demo inbox",
  };
  return names[provider];
}

/* --------------------------------------------------------------- channels */

export function channelVisual(kind: ChannelKind): {
  color: string;
  glyph: string;
} {
  switch (kind) {
    case "discord":
      return { color: "var(--discord)", glyph: "◎" };
  }
}

/* --------------------------------------------------------------- people */

const AVATAR_COLORS = [
  "#c8643c",
  "#3f7d6e",
  "#7c9a6b",
  "#9a6b8f",
  "#c2913a",
  "#4c74a8",
  "#a85a4c",
];

/** Up-to-two-letter initials from a display name. */
export function initialsOf(name: string): string {
  const parts = name
    .replace(/[^\p{L}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Stable colour for a sender avatar, derived from their name. */
export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  requires_action: "Requires action",
  important: "Important",
  noise: "Noise",
};
