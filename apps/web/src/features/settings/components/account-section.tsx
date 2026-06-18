import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { authClient, signOut, useSession } from "@/lib/api/auth-client";
import { Icon } from "@/components/icon";
import { initials, avatarColor } from "@/lib/initials";

// account-settings S-002: the Account section body. Shows the signed-in user's identity
// (avatar · name · email/provider/verified/joined — all read-only, C-003), lets them edit
// their display name (non-empty, ≤80 chars — C-004), and offers a quiet sign-out row.
//
// Canonical shape: Anchord-Design/settings.jsx `AccountSection`. The bio field + avatar
// change/remove the prototype shows are OUT of v0 scope (deferred) and intentionally omitted.
//
// Identity sources: email-verified + join date come from the session `user`
// (`emailVerified`, `createdAt`). The sign-in provider is NOT on `user` — it lives in the
// better-auth `account` record, read via `authClient.listAccounts()`. If that isn't available
// the rest of the readout still renders.

const NAME_MAX = 80;

// Map a better-auth providerId to a label + icon. `credential` = email+password sign-up.
function providerMeta(providerId: string): { label: string; icon: string | null } {
  switch (providerId) {
    case "google":
      return { label: "Google", icon: "google" };
    case "github":
      return { label: "GitHub", icon: "github" };
    case "credential":
    case "email":
      return { label: "Email", icon: "mail" };
    default:
      return { label: providerId, icon: null };
  }
}

function joinedLabel(createdAt: string | Date | undefined): string | null {
  if (!createdAt) return null;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function AccountSection() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const user = session?.user as
    | { name?: string; email?: string; emailVerified?: boolean; createdAt?: string | Date }
    | undefined;

  const storedName = (user?.name ?? "").trim();
  const email = user?.email ?? "";
  const verified = Boolean(user?.emailVerified);
  const joined = joinedLabel(user?.createdAt);

  const [name, setName] = useState(storedName);
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState<{ label: string; icon: string | null } | null>(null);

  // Keep the editable field in sync if the session name changes underneath us (e.g. after save).
  useEffect(() => {
    setName(storedName);
  }, [storedName]);

  // The sign-in provider lives in the `account` record. Read it client-side; degrade silently.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await authClient.listAccounts();
        const first = res?.data?.[0];
        if (alive && first?.providerId) setProvider(providerMeta(first.providerId));
      } catch {
        // No provider surface available — AS-005's other fields still render.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const trimmed = name.trim();
  const tooLong = name.length > NAME_MAX;
  const empty = trimmed.length === 0;
  const dirty = name !== storedName;
  const invalid = empty || tooLong;

  async function handleSave() {
    // C-004: refuse empty or over-length before touching the server; stored name unchanged.
    if (empty) {
      toast.error("Display name can't be empty.");
      return;
    }
    if (tooLong) {
      toast.error(`Display name must be ${NAME_MAX} characters or fewer.`);
      return;
    }
    setSaving(true);
    try {
      const res = await authClient.updateUser({ name: trimmed });
      if (res?.error) {
        toast.error("Couldn't update your profile. Try again.");
        return;
      }
      toast.success("Profile updated.");
    } catch {
      toast.error("Couldn't update your profile. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    navigate("/signin", { replace: true });
  }

  const displayName = storedName || email || "Your account";

  return (
    <div className="flex flex-col gap-5">
      {/* Profile card — identity readout (all read-only). */}
      <div className="rounded-[12px] border border-line bg-elev p-5">
        <div className="flex items-start gap-4">
          <span
            data-testid="account-avatar"
            className="inline-flex size-14 flex-none items-center justify-center rounded-full font-mono text-[18px] font-semibold text-white"
            style={{ background: avatarColor(displayName) }}
          >
            {initials(displayName)}
          </span>
          <div className="min-w-0">
            <div className="text-[16px] font-semibold text-ink">{displayName}</div>
            <div data-testid="account-identity-line" className="mt-0.5 text-[12.5px] text-muted">
              {email}
              {joined && (
                <>
                  {email ? " · " : ""}
                  joined {joined}
                </>
              )}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {provider && (
                <span
                  data-testid="account-provider-badge"
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-surface px-2 py-1 text-[11.5px] text-muted"
                >
                  {provider.icon && <Icon name={provider.icon} size={13} />}
                  {provider.label}
                </span>
              )}
              {verified && (
                <span
                  data-testid="account-verified-badge"
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-surface px-2 py-1 text-[11.5px] text-muted"
                >
                  <span className="size-1.5 rounded-full bg-[var(--green,#43b873)]" />
                  Verified
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Editable form — display name (editable) + email (read-only). */}
      <div className="rounded-[12px] border border-line bg-elev">
        <div className="flex flex-col gap-5 p-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="account-display-name" className="text-[12.5px] font-medium text-ink">
              Display name
            </label>
            <input
              id="account-display-name"
              data-testid="account-display-name"
              className="rounded-[7px] border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={invalid || undefined}
            />
            {tooLong && (
              <span data-testid="account-name-error" className="text-[11.5px] text-[var(--red,#f1655d)]">
                Display name must be {NAME_MAX} characters or fewer.
              </span>
            )}
            {empty && (
              <span data-testid="account-name-error" className="text-[11.5px] text-[var(--red,#f1655d)]">
                Display name can't be empty.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="account-email" className="text-[12.5px] font-medium text-ink">
              Email
            </label>
            <input
              id="account-email"
              data-testid="account-email"
              className="rounded-[7px] border border-line bg-sunken px-3 py-2 text-[13px] text-muted outline-none"
              value={email}
              readOnly
              tabIndex={-1}
            />
            <span className="text-[11.5px] text-subtle">Email address can't be changed.</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-3.5">
          {dirty && !invalid && (
            <span className="text-[11.5px] text-subtle">Unsaved changes</span>
          )}
          <button
            type="button"
            data-testid="account-save"
            disabled={!dirty || invalid || saving}
            onClick={handleSave}
            className="inline-flex h-9 items-center rounded-[7px] bg-accent px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
          >
            Save changes
          </button>
        </div>
      </div>

      {/* Quiet sign-out row. */}
      <div className="flex items-center justify-between rounded-[12px] border border-line bg-elev p-5">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">Sign out</div>
          <div className="mt-0.5 text-[12px] text-subtle">
            You'll be signed out on this device.
          </div>
        </div>
        <button
          type="button"
          data-testid="account-sign-out"
          onClick={handleSignOut}
          className="inline-flex h-9 items-center gap-2 rounded-[7px] border border-line bg-surface px-3.5 text-[12.5px] font-medium text-ink hover:bg-elev"
        >
          <Icon name="logout" size={15} />
          Sign out
        </button>
      </div>
    </div>
  );
}
