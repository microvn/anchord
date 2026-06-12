import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Icon } from "@/components/icon";
import { initials, avatarColor } from "@/lib/initials";
import type { SharePerson, ShareRole } from "@/features/sharing/client";

// PeopleList (sharing-permissions-ui S-004 + S-006) — renders every shared person as a row: avatar,
// name, email, role, and a Pending tag when not yet active (AS-014). An ACTIVE non-owner member
// shows an editable role dropdown (viewer | commenter | editor — owner is NEVER an option, C-004);
// the OWNER row shows a static "Owner" label with NO dropdown and NO Remove control (owner is not a
// reassignable or removable member, C-004 / backend C-017). A pending invitee shows the "Pending"
// badge AND can be removed (revoke the invite).
//
// S-006: the role dropdown + Remove control persist. The row state (people[] incl. each role) is
// OWNED by the dialog (ShareSections) so it can optimistically update + reconcile/rollback (C-005);
// PeopleList is presentational and calls back via `onChangeRole` / `onRemove`. Each mutation targets
// the person's doc_members `id` (the PATCH/DELETE member routes need it).

const ROLE_OPTS: ShareRole[] = ["viewer", "commenter", "editor"];
const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

export function PeopleList({
  people,
  onChangeRole,
  onRemove,
}: {
  people: SharePerson[];
  /** persist a role change for the active non-owner row (S-006). Absent → the dropdown is display-only. */
  onChangeRole?: (person: SharePerson, role: ShareRole) => void;
  /** persist a removal for an active member / pending invite (S-006). Absent → no Remove control. */
  onRemove?: (person: SharePerson) => void;
}) {
  return (
    <div data-testid="share-people-list" className="flex flex-col gap-1.5">
      {people.map((p) => (
        <PersonRow
          key={p.id ?? p.userId ?? p.email}
          person={p}
          onChangeRole={onChangeRole}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

function PersonRow({
  person,
  onChangeRole,
  onRemove,
}: {
  person: SharePerson;
  onChangeRole?: (person: SharePerson, role: ShareRole) => void;
  onRemove?: (person: SharePerson) => void;
}) {
  const name = person.name ?? person.email;
  const isOwner = person.role === "owner";

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
        // C-004: the owner is not a reassignable / removable member — a static label, no controls.
        <span data-testid={`share-person-role-${person.email}`} className="flex-none text-[12px] text-muted">
          Owner
        </span>
      ) : (
        <>
          <Select
            value={person.role as ShareRole}
            onValueChange={(v) => onChangeRole?.(person, v as ShareRole)}
          >
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
          {onRemove && (
            <button
              type="button"
              data-testid={`share-person-remove-${person.email}`}
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              onClick={() => onRemove(person)}
              className="grid size-7 flex-none place-items-center rounded-md text-subtle hover:bg-elev hover:text-error"
            >
              <Icon name="trash" size={15} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
