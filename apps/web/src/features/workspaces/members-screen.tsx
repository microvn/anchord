import { useForm, type Resolver } from "react-hook-form";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveWorkspace } from "./active-workspace";
import { useMembers } from "./use-bootstrap";
import { inviteMember, removeMember, changeMemberRole } from "./client";
import { queryKeys } from "./query-keys";
import { ErrorState } from "../../components/error-state";
import { EmptyState } from "../../components/empty-state";
import type { MemberRow, InvitationRow, WorkspaceRole } from "./types";

// S-003 MembersScreen (AS-007..AS-012 / C-002). ADMIN-ONLY management: a non-admin sees a
// read-only view with NO manage controls (invite/remove/change-role hidden). The directory is
// read via useMembers, which is keyed by workspaceId (GAP-001) so switching workspace never
// flashes another workspace's members. Mobile: full-width rows, tap targets ≥40px (C-003,
// [→MANUAL] for pixels).

const inviteSchema = z.object({
  // AS-012: client-side email validation (inline) BEFORE the request — a malformed email
  // never reaches the invite endpoint.
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
  role: z.enum(["admin", "member"]),
});
type InviteForm = z.infer<typeof inviteSchema>;

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
  const { workspace, isAdmin } = useActiveWorkspace();

  // C-002 / AS-011: the member directory endpoint is admin-only on the backend (a non-admin's
  // request 403s). So a non-admin gets the read-only surface directly — no manage controls,
  // no member fetch — never an error page from a forbidden read.
  if (!isAdmin) {
    return (
      <section className="px-4 py-6" data-testid="members-screen">
        <h2 className="font-serif text-xl text-ink">Members</h2>
        <p data-testid="members-readonly" className="mt-2 text-sm text-muted">
          You have read-only access to this workspace's members.
        </p>
      </section>
    );
  }

  return <AdminMembers workspaceId={workspace.id} />;
}

function AdminMembers({ workspaceId }: { workspaceId: string }) {
  const query = useMembers(workspaceId);

  if (query.isPending) {
    return (
      <p className="px-4 py-8 text-sm text-muted" data-testid="members-loading">
        Loading…
      </p>
    );
  }
  if (query.isError) {
    return <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />;
  }

  const members = query.data?.members ?? [];
  const invitations = query.data?.invitations ?? [];

  return (
    <section className="px-4 py-6" data-testid="members-screen">
      <h2 className="font-serif text-xl text-ink">Members</h2>

      <InviteRow workspaceId={workspaceId} />

      <ul className="mt-4 flex flex-col gap-1">
        {members.map((m) => (
          <MemberRowView key={m.userId} member={m} workspaceId={workspaceId} canManage />
        ))}
        {invitations.map((inv) => (
          <InvitePendingRow key={inv.id} invitation={inv} />
        ))}
      </ul>

      {members.length === 0 && invitations.length === 0 && (
        <EmptyState title="No members yet" description="Invite someone by email to get started." />
      )}
    </section>
  );
}

function InviteRow({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteForm>({
    resolver: inviteResolver,
    defaultValues: { email: "", role: "member" },
  });

  async function onSubmit(values: InviteForm) {
    await inviteMember(workspaceId, values.email, values.role);
    // The new pending invite lives in the members directory — refetch this workspace's slice.
    await queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
    reset();
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="mt-3 flex flex-wrap items-start gap-2"
      data-testid="invite-row"
    >
      <div className="flex min-w-[200px] flex-1 flex-col">
        <input
          {...register("email")}
          data-testid="invite-email"
          placeholder="name@example.com"
          aria-invalid={errors.email ? "true" : undefined}
          className="min-h-[40px] rounded-md border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
        />
        {errors.email && (
          <p role="alert" data-testid="invite-email-error" className="mt-1 text-xs text-error">
            {errors.email.message}
          </p>
        )}
      </div>
      <select
        {...register("role")}
        data-testid="invite-role"
        className="min-h-[40px] rounded-md border border-line bg-surface px-2 text-sm text-ink"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>
      <button
        type="submit"
        data-testid="invite-submit"
        disabled={isSubmitting}
        className="min-h-[40px] rounded-md bg-accent px-4 text-sm font-medium text-on-accent disabled:opacity-60"
      >
        Invite
      </button>
    </form>
  );
}

function MemberRowView({
  member,
  workspaceId,
  canManage,
}: {
  member: MemberRow;
  workspaceId: string;
  canManage: boolean;
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
    <li
      data-testid={`member-row-${member.userId}`}
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm text-ink">{member.name}</span>
        <span className="truncate text-xs text-muted">{member.email}</span>
      </div>

      {canManage ? (
        <div className="flex items-center gap-2">
          {/* AS-010: change role */}
          <select
            data-testid={`role-${member.userId}`}
            value={member.role}
            onChange={(e) => void onRole(e.target.value as WorkspaceRole)}
            className="min-h-[40px] rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          {/* AS-009: remove */}
          <button
            type="button"
            data-testid={`remove-${member.userId}`}
            aria-label={`Remove ${member.name}`}
            onClick={() => void onRemove()}
            className="min-h-[40px] rounded-md border border-line px-3 text-sm text-muted hover:border-error hover:text-error"
          >
            Remove
          </button>
        </div>
      ) : (
        // Read-only: role shown as text, no manage affordance (C-002, AS-011).
        <span className="text-xs uppercase tracking-wide text-muted">{member.role}</span>
      )}
    </li>
  );
}

function InvitePendingRow({ invitation }: { invitation: InvitationRow }) {
  return (
    <li
      data-testid={`invite-row-${invitation.id}`}
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-line bg-surface px-3 py-2"
    >
      <span className="truncate text-sm text-muted">{invitation.email}</span>
      <span
        data-testid={`invite-status-${invitation.id}`}
        className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent"
      >
        {invitation.status}
      </span>
    </li>
  );
}
