import { useForm, type Resolver } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { Icon } from "../../components/icon";
import { invitePerson, type ShareRole, type SharePerson } from "./client";

// InviteRow (sharing-permissions-ui S-003) — invite a person by email + role + optional message.
// Mirrors the workspaces members-screen InviteRow (RHF + a flat Zod resolver, segmented role
// toggle) but adapted to the doc-share roles (viewer|commenter|editor — never owner, C-004) and
// the doc-scoped POST /invites. On submit it optimistically appends a person row, calls the
// backend, and reconciles the row's status (active|pending, AS-010/AS-011) — or rolls the
// optimistic row back on a refused/failed write (C-005/AS-013). A malformed email is rejected
// inline by the resolver BEFORE the request (C-006/AS-012) — the same inline check as members.

const inviteSchema = z.object({
  // AS-012/C-006: inline email validation BEFORE the request — a malformed email never reaches POST.
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
  role: z.enum(["viewer", "commenter", "editor"]),
  message: z.string().optional(),
});
type InviteForm = z.infer<typeof inviteSchema>;

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

export function InviteRow({
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
  /** replace the optimistic row's status once the backend answers (active|pending). */
  onReconcile: (email: string, status: SharePerson["status"]) => void;
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
    const res = await invitePerson(workspaceId, slug, {
      email,
      role: values.role,
      ...(values.message ? { message: values.message } : {}),
    });
    if (res.error || !res.data) {
      // AS-013/C-005: refused/failed write → remove the optimistic row + error, no ghost.
      onRollback(email);
      toast.error("Couldn't send the invite");
      return;
    }
    onReconcile(email, res.data.status);
    reset();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-2" data-testid="invite-row" noValidate>
      <div className="flex flex-wrap items-center gap-[9px]">
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
            placeholder="Invite by email address…"
            aria-invalid={errors.email ? "true" : undefined}
            className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-subtle"
          />
        </label>

        {/* role toggle — viewer | commenter | editor only (C-004: never owner). */}
        <div
          className="inline-flex gap-0.5 rounded-[8px] border border-line bg-sunken p-0.5"
          data-testid="invite-role-toggle"
          role="group"
          aria-label="Invite role"
        >
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              data-testid={`invite-role-${r}`}
              aria-pressed={role === r}
              onClick={() => setValue("role", r)}
              className={`inline-flex h-7 items-center rounded-[6px] px-[12px] text-[12.5px] transition-colors ${
                role === r
                  ? "bg-surface font-semibold text-accent-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                  : "font-medium text-muted hover:text-ink"
              }`}
            >
              {roleLabel(r)}
            </button>
          ))}
        </div>

        <button
          type="submit"
          data-testid="invite-submit"
          disabled={isSubmitting}
          className="inline-flex h-8 flex-none items-center gap-[7px] rounded-[8px] bg-accent px-3 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50 max-[599px]:flex-1 max-[599px]:justify-center"
        >
          Invite
        </button>
      </div>

      <input
        {...register("message")}
        data-testid="invite-message"
        type="text"
        placeholder="Add a message (optional)"
        className="h-[34px] w-full rounded-[8px] border border-line bg-surface px-[11px] text-[12.5px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-subtle focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
      />

      {errors.email && (
        <p role="alert" data-testid="invite-email-error" className="text-[11.5px] text-error">
          {errors.email.message}
        </p>
      )}
    </form>
  );
}
