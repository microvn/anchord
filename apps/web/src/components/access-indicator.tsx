// S-003 shared primitive: shows a doc's general-access level (restricted / anyone-in-workspace
// / anyone-with-link). web-core owns it so the share dialog, viewer top bar, and doc grid all
// render the same indicator. Muted chrome text, teal accent for the open-link state; no raw
// hex (C-003). The user's rendered doc content is never styled by this system.
export type AccessLevel = "restricted" | "workspace" | "link";

const LABELS: Record<AccessLevel, string> = {
  restricted: "Restricted",
  workspace: "Anyone in workspace",
  link: "Anyone with link",
};

export function AccessIndicator({ access }: { access?: string | null }) {
  // Unknown / empty level → a safe fallback, never a crash (edge case).
  const known = access && access in LABELS ? (access as AccessLevel) : null;
  const label = known ? LABELS[known] : "Unknown access";
  // Only the link-shared state leans on the accent; restricted/workspace stay low-contrast.
  const accent = known === "link";

  return (
    <span
      data-access={known ?? "unknown"}
      className={
        accent
          ? "inline-flex items-center gap-1 text-xs text-accent"
          : "inline-flex items-center gap-1 text-xs text-muted"
      }
    >
      {label}
    </span>
  );
}
