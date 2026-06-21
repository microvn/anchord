import { memo } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  invitePerson,
  type InviteResult,
  type ShareRole,
  type SharePerson,
} from "@/features/sharing/services/client";
import { inviteSchema, type InviteForm } from "@/features/sharing/schema/invite";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";

// InviteRow (sharing-permissions-ui S-003) — invite a person by email + role + optional message.
// Mirrors the workspaces members-screen InviteRow (RHF + a flat Zod resolver, segmented role
// toggle) but adapted to the doc-share roles (viewer|commenter|editor — never owner, C-004) and
// the doc-scoped POST /invites. On submit it optimistically appends a person row, calls the
// backend, and reconciles the row's status (active|pending, AS-010/AS-011) — or rolls the
// optimistic row back on a refused/failed write (C-005/AS-013). A malformed email is rejected
// inline by the resolver BEFORE the request (C-006/AS-012) — the same inline check as members.

// A version-proof Zod→RHF resolver (safeParse + flat field-map), same rationale as members-screen:
// the project is on Zod 4 and @hookform/resolvers reads Zod 3 internals.
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

const ROLES: ShareRole[] = ["viewer", "commenter", "editor"];
const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

// Memoized: holds an RHF form (its own local state). Parent stabilizes workspaceId/slug (props) and
// onOptimisticAdd/onReconcile/onRollback (useCallback), so it no longer re-renders the form on every
// tab toggle / access change / people mutation in the dialog.
export const InviteRow = memo(function InviteRow({
  workspaceId,
  slug,
  onOptimisticAdd,
  onReconcile,
  onRollback,
}: {
  workspaceId: string;
  slug: string;
  /** append an optimistic person row (temp), returns the temp key used to reconcile/rollback it. */
  onOptimisticAdd: (person: SharePerson) => void;
  /** replace the optimistic row's status + bind its member id once the backend answers
   *  (active|pending). The id makes the row immediately removable / role-changeable (AS-022). */
  onReconcile: (email: string, status: SharePerson["status"], id: string) => void;
  /** remove the optimistic row on a refused/failed write (C-005). */
  onRollback: (email: string) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<InviteForm>({
    resolver: inviteResolver,
    defaultValues: { email: "", role: "commenter", message: "" },
  });
  const role = watch("role");

  async function onSubmit(values: InviteForm) {
    const email = values.email.trim();
    // AS-010/AS-011: optimistic active row; reconcile to the backend's status (active|pending).
    onOptimisticAdd({ email, role: values.role, status: "active" });
    // The thunk returns the RAW Eden envelope; unwrap so `res.data` is the payload (not the
    // `{success,data,…}` wrapper) — otherwise `res.data.status` is undefined and the Pending
    // reconcile (AS-011) silently breaks. Same convention as the other sharing call sites.
    const res = unwrapEnvelope<InviteResult>(
      await invitePerson(workspaceId, slug, {
        email,
        role: values.role,
        ...(values.message ? { message: values.message } : {}),
      }),
    );
    if (res.error || !res.data) {
      // AS-013/C-005: refused/failed write → remove the optimistic row + error, no ghost.
      onRollback(email);
      toast.error("Couldn't send the invite");
      return;
    }
    onReconcile(email, res.data.status, res.data.id);
    reset();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-2.5" data-testid="invite-row" noValidate>
      {/* Row 1 — email, full width. Enter submits the form → invites this email immediately (each
          Enter sends one), so the row appears below without leaving the field (AS-010/011). */}
      <label
        className={`flex h-[40px] items-center gap-2 rounded-[9px] border bg-surface px-3 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)] ${
          errors.email ? "border-error" : "border-line"
        }`}
      >
        <Icon name="mail" size={15} className="flex-none text-subtle" />
        <input
          {...register("email")}
          data-testid="invite-email"
          type="email"
          placeholder="Type an email and press Enter"
          aria-invalid={errors.email ? "true" : undefined}
          className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-subtle"
        />
      </label>

      {/* Row 2 — role (left) + Send (right). Role dropdown applies to the email being sent now
          (viewer | commenter | editor only — never owner, C-004). */}
      <div className="flex items-center justify-between gap-2">
        <Select value={role} onValueChange={(v) => setValue("role", v as ShareRole)}>
          <SelectTrigger data-testid="invite-role-trigger" className="h-9 w-[150px]" aria-label="Invite role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-testid="invite-role-options">
            {ROLES.map((r) => (
              <SelectItem key={r} value={r} data-testid={`invite-role-opt-${r}`}>
                {roleLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" data-testid="invite-submit" disabled={isSubmitting}>
          <Icon name="arrowRight" size={15} />
          Send
        </Button>
      </div>

      {/* Row 3 — optional note, carried in the invite email. */}
      <textarea
        {...register("message")}
        data-testid="invite-message"
        rows={2}
        placeholder="Add a note (optional) — included in the email."
        className="w-full resize-none rounded-[9px] border border-line bg-surface px-3 py-2 text-[12.5px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-subtle focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
      />

      <p className="font-mono text-[11px] tracking-[0.02em] text-subtle">
        Press Enter after each email · revoke any time.
      </p>

      {errors.email && (
        <p role="alert" data-testid="invite-email-error" className="text-[11.5px] text-error">
          {errors.email.message}
        </p>
      )}
    </form>
  );
});
