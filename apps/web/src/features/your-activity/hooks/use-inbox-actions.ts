import { useMutation } from "@tanstack/react-query";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { addComment, setResolution } from "@/features/viewer/services/client";
import type { AddCommentResult, SetResolutionResult } from "@/features/viewer/services/client";
import { acceptInvitation, rejectInvitation } from "@/features/workspaces/services/client";

// your-activity-inbox S-004 — reply + resolve a thread straight from the inbox detail.
//
// C-003: the inbox NEVER bypasses the source action's authorization. Reply/resolve go through the
// EXISTING doc-addressed annotation routes (`addComment` / `setResolution`), which the backend
// re-authorizes by session role (commenter+). There is deliberately NO client-side role gate here:
// a viewer / revoked caller comes back with `EdenResult.error` and the detail SURFACES the refusal
// (AS-015) — we invoke and handle the result, never pre-empt or fake it.
//
// Both calls are doc-addressed (slug + annotation id). For an inbox item, `slug` is the doc slug
// (S-001 enrichment) and `refId` is the annotation (thread) id. These mutations live in the
// `your-activity` feature, wrapping the viewer thunks — they do not belong to the viewer feature.

/** AS-013: post a reply to a thread via the annotation comment path. */
export function useReplyToThread() {
  return useMutation<
    AddCommentResult,
    Error,
    { slug: string; annotationId: string; body: string }
  >({
    mutationFn: async ({ slug, annotationId, body }) => {
      const res = unwrapEnvelope<AddCommentResult>(
        await addComment(slug, annotationId, { body }),
      );
      // C-003 / AS-015: a server refusal (viewer role, revoked access) comes back as `error` — throw
      // so the caller surfaces it. NEVER swallow it or fake success.
      if (res.error || !res.data) throw new Error("reply-failed");
      return res.data;
    },
  });
}

/** AS-014: resolve a thread from the inbox via the resolution toggle. */
export function useResolveThread() {
  return useMutation<
    SetResolutionResult,
    Error,
    { slug: string; annotationId: string }
  >({
    mutationFn: async ({ slug, annotationId }) => {
      const res = unwrapEnvelope<SetResolutionResult>(
        await setResolution(slug, annotationId, { resolved: true }),
      );
      if (res.error || !res.data) throw new Error("resolve-failed");
      return res.data;
    },
  });
}

// your-activity-inbox S-005 — accept / decline a workspace invite straight from the inbox detail.
//
// C-003 / C-007: the inbox NEVER bypasses the source action's authorization. Accept/decline go
// through the EXISTING invitation routes (`acceptInvitation` / `rejectInvitation`), which authorize
// by the session email matching the invited email (the email-match gate). The call is TOKENLESS —
// the inbox passes ONLY the invitation id (read from the notification's dedicated `invitationId`
// field), never a token. A server refusal (the invite was revoked / already settled since it landed
// in the inbox) comes back as `EdenResult.error`; we throw so the detail can degrade gracefully
// (AS-019: "this invitation is no longer available"), never a dead error.

/** AS-016: accept a workspace invite (tokenless) targeting its dedicated invitation id. */
export function useAcceptInvite() {
  return useMutation<unknown, Error, { invitationId: string }>({
    mutationFn: async ({ invitationId }) => {
      const res = unwrapEnvelope<unknown>(await acceptInvitation(invitationId));
      if (res.error || !res.data) throw new Error("accept-invite-failed");
      return res.data;
    },
  });
}

/** AS-017: decline (reject) a workspace invite (tokenless) targeting its dedicated invitation id. */
export function useDeclineInvite() {
  return useMutation<unknown, Error, { invitationId: string }>({
    mutationFn: async ({ invitationId }) => {
      const res = unwrapEnvelope<unknown>(await rejectInvitation(invitationId));
      if (res.error || !res.data) throw new Error("decline-invite-failed");
      return res.data;
    },
  });
}
