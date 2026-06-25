import { useForm, type Resolver } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveWorkspace } from "./active-workspace";
import { useMembers, useBootstrap } from "@/features/workspaces/hooks/use-bootstrap";
import { RenameField } from "./rename-field";
import {
  inviteMember,
  removeMember,
  changeMemberRole,
  revokeInvitation,
} from "@/features/workspaces/services/client";
import { queryKeys } from "@/features/workspaces/lib/query-keys";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Icon } from "@/components/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { initials, avatarColor } from "@/lib/initials";
import type { MemberRow, InvitationRow, WorkspaceRole } from "@/features/workspaces/types";
import { inviteSchema, type InviteForm } from "@/features/workspaces/schema/invite";
import { usePageMeta } from "@/hooks/use-page-meta";

// S-003 MembersScreen (AS-007..AS-012 / C-002). ADMIN-ONLY management: a non-admin sees a
// read-only view with NO manage controls (invite/remove/change-role hidden). The directory is
// read via useMembers, which is keyed by workspaceId (GAP-001) so switching workspace never
// flashes another workspace's members. Visual structure mirrors the Anchord-Design `MembersScreen`
// (page-head / list-head / member-row / avatar / you-tag / badge / role-select / pending section).
// Mobile: the .list-head hides and rows reflow (C-003, [→MANUAL] for pixels).

// A tiny Zod→RHF resolver. We bind RHF's validation to the Zod schema directly instead of
// `@hookform/resolvers/zod`, whose 3.x build reads Zod 3's error internals (`unionErrors`)
// and rethrows on a Zod 4 error shape — the project is on Zod 4. safeParse + a flat field-map
// is version-proof and keeps the form "RHF + Zod" as the stack mandates.
const inviteResolver: Resolver<InviteForm> = async (values) => {
  const parsed = inviteSchema.safeParse(values);
  if (parsed.success) return { values: parsed.data, errors: {} };
  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !errors[field]) {
      errors[field] = { type: issue.code, message: issue.message };
    }
  }
  return { values: {}, errors: errors as never };
};

export function MembersScreen() {
  usePageMeta("Members");
  const { workspace, isAdmin } = useActiveWorkspace();

  // C-002 / AS-011: the member directory endpoint is admin-only on the backend (a non-admin's
  // request 403s). So a non-admin gets the read-only surface directly — no manage controls,
  // no member fetch — never an error page from a forbidden read.
  if (!isAdmin) {
    return (
      <section className="mx-auto max-w-[1080px] px-6 py-8" data-testid="members-screen">
        <PageHead isAdmin={false} />
        <p data-testid="members-readonly" className="mt-3.5 text-[12.5px] text-subtle">
          Only an admin can invite or manage members.
        </p>
      </section>
    );
  }

  return <AdminMembers workspaceId={workspace.id} />;
}

function PageHead({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="mb-[22px] flex items-end gap-4">
      <div>
        <div className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">
          Settings
        </div>
        <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.03em] text-ink">
          Members
        </h1>
        <div className="mt-[5px] text-[13.5px] text-muted">
          {isAdmin ? "Manage who can access this workspace." : "People in this workspace."}
        </div>
      </div>
      {isAdmin && (
        <div className="ml-auto flex flex-none items-center gap-2">
          {/* The page-head rename trigger (admin-only). RenameField owns the edit flow. */}
          <RenameField />
        </div>
      )}
    </div>
  );
}

function AdminMembers({ workspaceId }: { workspaceId: string }) {
  const query = useMembers(workspaceId);
  const bootstrap = useBootstrap();
  const myUserId = bootstrap.data?.userId ?? null;

  if (query.isPending) {
    return (
      <p className="mx-auto max-w-[1080px] px-6 py-8 text-sm text-muted" data-testid="members-loading">
        Loading…
      </p>
    );
  }
  if (query.isError) {
    return <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />;
  }

  const members = query.data?.members ?? [];
  // Only genuinely-pending invites belong in the pending section (the directory may carry
  // accepted/rejected/revoked rows depending on the backend slice).
  const invitations = (query.data?.invitations ?? []).filter((i) => i.status === "pending");

  return (
    <section className="mx-auto max-w-[1080px] px-6 py-8" data-testid="members-screen">
      <PageHead isAdmin />

      <InviteRow workspaceId={workspaceId} />

      {members.length === 0 && invitations.length === 0 ? (
        <EmptyState title="It's just you" description="Invite teammates by email to share and annotate docs together in this workspace." />
      ) : (
        <>
          <div className="mt-4 overflow-hidden rounded-[11px] border border-line bg-surface">
            <ListHead />
            {members.map((m) => (
              <MemberRowView
                key={m.userId}
                member={m}
                workspaceId={workspaceId}
                isSelf={myUserId != null && m.userId === myUserId}
              />
            ))}
          </div>

          {invitations.length > 0 && (
            <div className="mt-[26px]">
              <div className="mb-3 flex items-center gap-[10px]">
                <span className="text-[15px] font-semibold text-ink">Pending invites</span>
                <span className="ml-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">
                  {invitations.length} pending
                </span>
              </div>
              <div className="overflow-hidden rounded-[11px] border border-line bg-surface">
                {invitations.map((inv) => (
                  <InvitePendingRow key={inv.id} invitation={inv} workspaceId={workspaceId} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ListHead() {
  return (
    // The .list-head row: hidden on mobile (the row reflows), shown ≥sm.
    <div className="hidden min-h-[38px] grid-cols-[1fr_120px_132px_40px] items-center gap-3 border-b border-line bg-elev px-3.5 sm:grid">
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-subtle">
        Member
      </span>
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-subtle">
        Status
      </span>
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-subtle">
        Role
      </span>
      <span />
    </div>
  );
}

// A 26px Mono-initial circle with a deterministic background (Anchord-Design `.avatar`).
function MemberAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-[26px] w-[26px] flex-none items-center justify-center overflow-hidden rounded-full font-mono text-[10.5px] font-semibold tracking-[0.02em] text-white"
      style={{ background: avatarColor(name) }}
    >
      {initials(name)}
    </span>
  );
}

function StatusBadge({ kind }: { kind: "active" | "invited" }) {
  if (kind === "invited") {
    return (
      <span className="inline-flex h-[19px] items-center gap-[5px] rounded-[6px] bg-amber-bg px-[7px] font-mono text-[11px] font-medium tracking-[0.04em] text-amber">
        <Icon name="clock" size={11} />
        Invited
      </span>
    );
  }
  return (
    <span className="inline-flex h-[19px] items-center gap-[5px] rounded-[6px] bg-accent-soft px-[7px] font-mono text-[11px] font-medium tracking-[0.04em] text-accent-ink">
      Active
    </span>
  );
}

function MemberRowView({
  member,
  workspaceId,
  isSelf,
}: {
  member: MemberRow;
  workspaceId: string;
  isSelf: boolean;
}) {
  const queryClient = useQueryClient();

  async function onRemove() {
    await removeMember(workspaceId, member.userId);
    await queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
  }

  async function onRole(role: WorkspaceRole) {
    await changeMemberRole(workspaceId, member.userId, role);
    await queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
  }

  return (
    <div
      data-testid={`member-row-${member.userId}`}
      className="grid min-h-[52px] grid-cols-[1fr_auto] items-start gap-x-3 gap-y-1.5 [grid-template-areas:'id_role''id_remove'] border-b border-line px-3.5 py-3 last:border-b-0 sm:grid-cols-[1fr_120px_132px_40px] sm:items-center sm:gap-y-0 sm:py-0 sm:[grid-template-areas:none]"
    >
      {/* member id */}
      <div className="flex min-w-0 items-center gap-[11px] [grid-area:id] sm:[grid-area:auto]">
        <MemberAvatar name={member.name || member.email} />
        <div className="min-w-0">
          <div className="flex items-center gap-[7px] text-[12.5px] font-semibold text-ink">
            <span className="truncate">{member.name || member.email}</span>
            {isSelf && (
              <span className="rounded-[4px] bg-accent-soft px-[5px] py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-accent-ink">
                you
              </span>
            )}
          </div>
          <div className="truncate text-[11.5px] text-subtle">{member.email}</div>
        </div>
      </div>

      {/* status — every active member is "Active" */}
      <div className="hidden items-center [grid-area:auto] sm:flex">
        <StatusBadge kind="active" />
      </div>

      {/* role */}
      <div className="flex items-center [grid-area:role] sm:[grid-area:auto]">
        {isSelf ? (
          // Self: static text, no control (you can't demote/remove yourself here).
          <span className="text-[12.5px] text-muted">
            {member.role === "admin" ? "Admin" : "Member"}
          </span>
        ) : (
          // AS-010: change role via the shadcn Select (the prototype's `.role-select` chrome).
          <Select
            value={member.role}
            onValueChange={(v) => void onRole(v as WorkspaceRole)}
          >
            <SelectTrigger
              data-testid={`role-${member.userId}`}
              aria-label={`Role for ${member.name || member.email}`}
              className="min-w-[96px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* remove (AS-009) — guarded by a confirm AlertDialog; only confirm runs removeMember. */}
      <div className="flex items-center justify-end [grid-area:remove] sm:[grid-area:auto]">
        {!isSelf && (
          <ConfirmDialog
            title="Remove member?"
            description={
              <>
                <span className="font-medium text-ink">{member.name || member.email}</span> will
                lose access to this workspace.
              </>
            }
            confirmLabel="Remove"
            confirmTestId={`remove-confirm-${member.userId}`}
            onConfirm={() => void onRemove()}
            trigger={
              <button
                type="button"
                data-testid={`remove-${member.userId}`}
                aria-label={`Remove ${member.name || member.email}`}
                title="Remove"
                className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-elev hover:text-ink"
              >
                <Icon name="trash" size={15} />
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}

function InvitePendingRow({
  invitation,
  workspaceId,
}: {
  invitation: InvitationRow;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();

  async function onRevoke() {
    // Revoke a PENDING invite via the invitations endpoint — NOT removeMember: an invitation
    // id is not a membership id, so DELETE /members/:id 404s ("not a member"). The members
    // refetch then drops the now-revoked invite from the pending list (AS-017).
    await revokeInvitation(workspaceId, invitation.id);
    await queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
  }

  const name = invitation.email.split("@")[0]!.replace(/[._]/g, " ");

  return (
    <div
      data-testid={`invite-row-${invitation.id}`}
      className="grid min-h-[52px] grid-cols-[1fr_auto] items-start gap-x-3 gap-y-1.5 [grid-template-areas:'id_role''id_remove'] border-b border-line px-3.5 py-3 last:border-b-0 sm:grid-cols-[1fr_120px_132px_40px] sm:items-center sm:gap-y-0 sm:py-0 sm:[grid-template-areas:none]"
    >
      <div className="flex min-w-0 items-center gap-[11px] [grid-area:id] sm:[grid-area:auto]">
        <MemberAvatar name={name || invitation.email} />
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold capitalize text-ink">{name}</div>
          <div className="truncate text-[11.5px] text-subtle">{invitation.email}</div>
        </div>
      </div>

      <div
        className="hidden items-center [grid-area:auto] sm:flex"
        data-testid={`invite-status-${invitation.id}`}
      >
        <StatusBadge kind="invited" />
      </div>

      <div className="flex items-center [grid-area:role] sm:[grid-area:auto]">
        <span className="text-[12.5px] text-muted">
          {invitation.role === "admin" ? "Admin" : "Member"}
        </span>
      </div>

      <div className="flex items-center justify-end [grid-area:remove] sm:[grid-area:auto]">
        <ConfirmDialog
          title="Revoke invite?"
          description={
            <>
              The invite to{" "}
              <span className="font-medium text-ink">{invitation.email}</span> will be cancelled.
            </>
          }
          confirmLabel="Revoke"
          confirmTestId={`revoke-confirm-${invitation.id}`}
          onConfirm={() => void onRevoke()}
          trigger={
            <button
              type="button"
              data-testid={`revoke-${invitation.id}`}
              aria-label="Revoke invite"
              title="Revoke invite"
              className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-elev hover:text-ink"
            >
              <Icon name="x" size={15} />
            </button>
          }
        />
      </div>
    </div>
  );
}

function InviteRow({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<InviteForm>({
    resolver: inviteResolver,
    defaultValues: { email: "", role: "member" },
  });
  const role = watch("role");

  async function onSubmit(values: InviteForm) {
    await inviteMember(workspaceId, values.email, values.role);
    // The new pending invite lives in the members directory — refetch this workspace's slice.
    await queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
    reset();
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="mt-1"
      data-testid="invite-row"
      noValidate
    >
      <div className="flex flex-wrap items-center gap-[9px]">
        {/* invite-field: a bordered shell holding the mail icon + the borderless input. */}
        <label
          className={`flex h-[38px] min-w-0 flex-1 basis-full items-center gap-2 rounded-[8px] border bg-surface px-[11px] transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)] sm:basis-auto ${
            errors.email ? "border-error" : "border-line"
          }`}
        >
          <Icon name="mail" size={15} className="flex-none text-subtle" />
          <input
            {...register("email")}
            data-testid="invite-email"
            type="email"
            placeholder="Invite by email…"
            aria-invalid={errors.email ? "true" : undefined}
            className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-subtle"
          />
        </label>

        {/* segmented Member/Admin toggle (the prototype `.fmt-toggle`). */}
        <div
          className="inline-flex gap-0.5 rounded-[8px] border border-line bg-sunken p-0.5"
          data-testid="invite-role-toggle"
          role="group"
          aria-label="Invite role"
        >
          {(["member", "admin"] as const).map((r) => (
            <button
              key={r}
              type="button"
              data-testid={`invite-role-${r}`}
              aria-pressed={role === r}
              onClick={() => setValue("role", r)}
              className={`inline-flex h-7 items-center rounded-[6px] px-[14px] text-[12.5px] transition-colors ${
                role === r
                  ? "bg-surface font-semibold text-accent-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                  : "font-medium text-muted hover:text-ink"
              }`}
            >
              {r === "admin" ? "Admin" : "Member"}
            </button>
          ))}
        </div>

        <button
          type="submit"
          data-testid="invite-submit"
          disabled={isSubmitting}
          className="inline-flex h-8 flex-none items-center gap-[7px] rounded-[8px] bg-accent px-3 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50 max-[599px]:flex-1 max-[599px]:justify-center"
        >
          Send invite
        </button>
      </div>

      {errors.email && (
        <p
          role="alert"
          data-testid="invite-email-error"
          className="mt-[7px] text-[11.5px] text-error"
        >
          {errors.email.message}
        </p>
      )}
    </form>
  );
}
