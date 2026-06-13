import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/api/auth-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Brandmark } from "@/components/icon";
import { AuthCenter } from "@/features/auth/components/auth-shell";
import { acceptInvitation, rejectInvitation, setActiveWorkspace } from "@/features/workspaces/services/client";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { queryKeys } from "@/features/workspaces/query-keys";
import { toApiError } from "@/lib/api/api-error";

// S-004 WorkspaceInviteLanding (AS-013/014/015 / GAP-002 — a DISTINCT route from auth-ui's
// per-doc invite landing). The invite link is `/invite/workspace/:invitationId?token=…&email=…`.
// The token authorizes the action; the email is the invited address, surfaced so the landing
// can refuse a WRONG ACCOUNT up front (AS-015) — the backend also enforces the email-match, but
// hides a mismatch as a uniform 404, so the FE pre-check gives the user the clear
// "this invite isn't for you" message instead of a generic not-found.
//
// Visual: Anchord-Design InviteLanding — a centered card with the workspace glyph + Decline/Accept.

interface AcceptResult {
  workspaceId: string;
  role: string;
}

export function WorkspaceInviteLanding() {
  const { invitationId } = useParams();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const invitedEmail = params.get("email");
  const { data: session } = useSession();
  const sessionEmail = session?.user?.email ?? null;

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AS-015: the signed-in account differs from the invited email → this invite is not for me.
  // No accept affordance is offered; I cannot join (case-insensitive compare).
  const wrongAccount =
    !!invitedEmail &&
    !!sessionEmail &&
    invitedEmail.trim().toLowerCase() !== sessionEmail.trim().toLowerCase();

  async function onAccept() {
    if (!invitationId) return;
    setBusy(true);
    setError(null);
    const result = unwrapEnvelope<AcceptResult>(await acceptInvitation(invitationId, token));
    if (result.error || !result.data) {
      setError(toApiError(result.error).message);
      setBusy(false);
      return;
    }
    // AS-013: joined → make the new membership visible, switch active, and navigate INTO it.
    const workspaceId = result.data.workspaceId;
    await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap() });
    try {
      await setActiveWorkspace(workspaceId);
    } catch {
      /* best-effort landing default (C-005) */
    }
    navigate(`/w/${workspaceId}/`);
  }

  async function onReject() {
    if (!invitationId) return;
    setBusy(true);
    setError(null);
    const result = unwrapEnvelope<{ rejected: boolean }>(
      await rejectInvitation(invitationId, token),
    );
    if (result.error) {
      setError(toApiError(result.error).message);
      setBusy(false);
      return;
    }
    // AS-014: rejected → no membership, stay where I was (a confirmation, no navigation).
    setRejected(true);
    setBusy(false);
  }

  if (rejected) {
    return (
      <AuthCenter>
        <p data-testid="invite-rejected" className="font-serif text-lg font-medium text-ink">
          Invitation declined.
        </p>
        <p className="mt-1 text-sm text-muted">You have not joined the workspace.</p>
      </AuthCenter>
    );
  }

  if (wrongAccount) {
    return (
      <AuthCenter>
        <p data-testid="invite-wrong-account" className="font-serif text-lg font-medium text-ink">
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
          You're invited
        </h1>
        <p className="mt-2 text-sm text-muted">Accept to join, or decline the invitation.</p>

        {error && (
          <p role="alert" className="mt-3 text-sm text-error">
            {error}
          </p>
        )}

        <div className="mt-[22px] flex gap-[9px]">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="flex-1"
            data-testid="invite-reject"
            disabled={busy}
            onClick={() => void onReject()}
          >
            Decline
          </Button>
          <Button
            type="button"
            size="lg"
            className="flex-1"
            data-testid="invite-accept"
            disabled={busy}
            onClick={() => void onAccept()}
          >
            {busy ? "Joining…" : "Accept invite"}
          </Button>
        </div>
      </Card>
    </AuthCenter>
  );
}
