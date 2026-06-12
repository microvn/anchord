import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useSession } from "@/lib/api/auth-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Brandmark, Icon } from "@/components/icon";
import { AuthCenter } from "./auth-shell";
import { acceptDocInvite } from "./client";
import { unwrapEnvelope } from "@/features/workspaces/use-bootstrap";

// auth-ui S-003 InviteAcceptLanding (AS-009/AS-010) — the PER-DOC invite accept-link landing.
// DISTINCT from workspaces-ui's WORKSPACE invite landing: this grants a ROLE ON A DOC and
// hits POST /api/invite/accept (backend route /api/invite/accept, src/routes/invite.ts),
// whereas the workspace one hits /api/invitations/:id/accept.
//
// Link shape: /invite/doc/:inviteId?token=…&email=…
//   - token: verified server-side against APP_SECRET (recomputed, no DB column).
//   - email: the invited address, carried in the link so the landing can show the AS-010
//     wrong-account message UP FRONT. The backend is authoritative — it resolves the
//     accepting email from the SESSION actor, never the body, and returns a uniform
//     { status: "not_accepted" } on any mismatch (no enumeration oracle) — but that uniform
//     refusal can't tell the user WHY, so the FE pre-check gives the clear message.
//
// AS-009: signed in with the matching email + confirm → role granted, taken to the doc.
// AS-010: signed in as the WRONG account → "this invite isn't for you", role NOT granted.
//
// Visual: Anchord-Design InviteLanding — a centered card with brand lockup + a doc glyph.

interface AcceptResult {
  status: "active" | "not_accepted";
  docId?: string;
  role?: string;
}

export function InviteAcceptLanding() {
  const { inviteId } = useParams();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const invitedEmail = params.get("email");
  const { data: session } = useSession();
  const sessionEmail = session?.user?.email ?? null;

  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AS-010: the signed-in account differs from the invited email → this invite is not mine.
  // No accept affordance is shown; the role can never be granted (case-insensitive compare).
  const wrongAccount =
    !!invitedEmail &&
    !!sessionEmail &&
    invitedEmail.trim().toLowerCase() !== sessionEmail.trim().toLowerCase();

  async function onAccept() {
    if (!inviteId) return;
    setBusy(true);
    setError(null);
    const result = unwrapEnvelope<AcceptResult>(await acceptDocInvite(inviteId, token));
    if (result.error || !result.data) {
      setError("Could not accept this invite. Please try again.");
      setBusy(false);
      return;
    }
    // The backend gives a uniform refusal as { status: "not_accepted" } (200, not an error
    // envelope) — surface it as a non-granting message, not a crash (defends AS-010 even if
    // the link's email param was absent so the FE pre-check didn't fire).
    if (result.data.status !== "active" || !result.data.docId) {
      setError("This invite isn't for you, or it's no longer valid.");
      setBusy(false);
      return;
    }
    // AS-009: role granted on the doc → take the user to it.
    navigate(`/d/${result.data.docId}`);
  }

  if (wrongAccount) {
    return (
      <AuthCenter>
        <p
          data-testid="doc-invite-wrong-account"
          className="font-serif text-lg font-medium text-ink"
        >
          This invite isn't for you.
        </p>
        <p className="mt-1 text-sm text-muted">
          It was sent to {invitedEmail}. Sign in with that account to accept it.
        </p>
      </AuthCenter>
    );
  }

  return (
    <AuthCenter>
      <Card className="px-7 py-8 text-center">
        <div className="flex items-center justify-center gap-2.5">
          <Brandmark size={22} />
          <span className="font-serif text-[19px] tracking-tight text-ink">anchord</span>
        </div>
        <h1 className="mt-3.5 font-serif text-[23px] font-medium tracking-tight text-ink">
          You've been invited to a document
        </h1>

        <div className="my-[18px] flex items-center justify-center gap-[11px] rounded-md bg-elev p-3.5">
          <span className="grid size-[34px] place-items-center rounded-md bg-accent-soft text-accent-ink">
            <Icon name="docs" size={16} />
          </span>
          <div className="text-left text-sm text-muted">Accept to get access to the document.</div>
        </div>

        {error && (
          <p role="alert" data-testid="doc-invite-error" className="mb-3 text-sm text-error">
            {error}
          </p>
        )}

        <Button
          type="button"
          size="lg"
          className="w-full"
          data-testid="doc-invite-accept"
          disabled={busy}
          onClick={() => void onAccept()}
        >
          {busy ? "Accepting…" : "Accept invite"}
        </Button>
      </Card>
    </AuthCenter>
  );
}
