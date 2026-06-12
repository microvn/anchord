import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Icon } from "../../components/icon";
import { initials, avatarColor } from "../../lib/initials";
import type { SharePerson, ShareRole } from "./client";

// PeopleList (sharing-permissions-ui S-004) — renders every shared person as a row: avatar, name,
// email, role, and a Pending tag when not yet active (AS-014). An ACTIVE non-owner member shows an
// editable role dropdown (viewer | commenter | editor — owner is NEVER an option, C-004); the OWNER
// row shows a static "Owner" label with no dropdown (owner is not a reassignable role). A pending
// invitee shows the "Pending" badge.
//
// NOTE (Not in Scope): persisting a doc-member role change has no backend route in v0 — AS-014 only
// requires the dropdown to be present + editable. The select is controlled locally; wiring a
// persist call awaits a backend per-member role-change route (spec Not in Scope / a future story).

const ROLE_OPTS: ShareRole[] = ["viewer", "commenter", "editor"];
const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

export function PeopleList({ people }: { people: SharePerson[] }) {
  return (
    <div data-testid="share-people-list" className="flex flex-col gap-1.5">
      {people.map((p) => (
        <PersonRow key={p.userId ?? p.email} person={p} />
      ))}
    </div>
  );
}

function PersonRow({ person }: { person: SharePerson }) {
  const name = person.name ?? person.email;
  const isOwner = person.role === "owner";
  // local role state — AS-014 requires an editable dropdown; persistence is out of scope (no route).
  const [role, setRole] = useState<ShareRole>(isOwner ? "editor" : (person.role as ShareRole));

  return (
    <div data-testid={`share-person-${person.email}`} className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full font-mono text-[10.5px] font-semibold text-white"
        style={{ background: avatarColor(name) }}
      >
        {initials(name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[13px] font-medium text-ink">
          {name}
          {person.status === "pending" && (
            <span
              data-testid={`share-person-pending-${person.email}`}
              className="inline-flex h-[18px] items-center gap-[5px] rounded-[6px] bg-amber-bg px-[6px] font-mono text-[10.5px] font-medium tracking-[0.04em] text-amber"
            >
              <Icon name="clock" size={10} />
              Pending
            </span>
          )}
        </div>
        <div className="truncate text-[11.5px] text-subtle">{person.email}</div>
      </div>
      {isOwner ? (
        // C-004: the owner is not a reassignable role — a static label, never a dropdown.
        <span data-testid={`share-person-role-${person.email}`} className="flex-none text-[12px] text-muted">
          Owner
        </span>
      ) : (
        <Select value={role} onValueChange={(v) => setRole(v as ShareRole)}>
          <SelectTrigger
            data-testid={`share-person-role-trigger-${person.email}`}
            className="h-7 w-[120px] flex-none"
            aria-label={`Role for ${name}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-testid={`share-person-role-options-${person.email}`}>
            {ROLE_OPTS.map((r) => (
              <SelectItem key={r} value={r} data-testid={`share-person-role-opt-${person.email}-${r}`}>
                {roleLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
