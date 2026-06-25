import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";

// NoAccessView (doc-access-routing S-003) — shown IN PLACE of the viewer when access resolution
// denies the doc (the doc read came back no-access / 404). Two variants, picked by whether the
// visitor has a session:
//
//   - "signin"   (signed-OUT visitor, AS-014/AS-016): signing in MIGHT grant access — show a
//                "Sign in to view" prompt with a CTA that carries a return-to-doc, so after sign-in
//                the visitor lands back on this exact doc (`/d/:slug`).
//   - "no-access" (signed-IN visitor, AS-015): a session is already present and STILL no access —
//                there is nothing to sign into; show a plain "you don't have access" message, NO
//                sign-in prompt.
//   - "deleted"  (doc-delete-trash S-004, AS-014): the doc EXISTED but was deleted into Trash, and
//                this viewer HAD access to it before the delete (the backend gates the 410
//                DOC_DELETED on prior access — a viewer with none gets the existence-hiding 404 →
//                the "signin"/"no-access" variants instead, AS-015). Session-agnostic: a member or a
//                prior guest sees the SAME "this doc was deleted" copy. No sign-in CTA (signing in
//                won't bring a deleted doc back); restore is only from Trash, so no inline action.
//
// Chrome recedes (DESIGN.md): a centered, low-chrome panel; the only accent is the single teal CTA
// on the sign-in variant. Responsive — a max-width centered column that holds at 360/768/1024/1440.

export type NoAccessVariant = "signin" | "no-access" | "deleted";

export function NoAccessView({
  variant,
  /** the doc's slug — used to build the return-to-doc target the sign-in CTA carries (AS-016). */
  slug,
  /** invoked when the sign-in CTA is pressed (signin variant only). The caller navigates to
   *  /signin carrying a return target of /d/:slug so sign-in returns the visitor to the doc. */
  onSignIn,
}: {
  variant: NoAccessVariant;
  slug?: string;
  onSignIn?: () => void;
}) {
  const isSignin = variant === "signin";
  const isDeleted = variant === "deleted";
  return (
    <div
      data-testid="no-access-view"
      data-variant={variant}
      className="mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-16 text-center"
    >
      <span
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-elev text-muted"
      >
        <Icon name={isDeleted ? "trash" : "shield"} size={20} />
      </span>
      {isDeleted ? (
        <>
          {/* doc-delete-trash S-004 / AS-014: the gated deleted notice — shown only to a viewer
              who had prior access (the backend's 410 DOC_DELETED is gated on that). Content is
              never rendered. No CTA: restore lives in Trash, not on the dead link. */}
          <p data-testid="no-access-title" className="font-serif text-base text-ink">
            This doc was deleted
          </p>
          <p className="text-sm text-muted">
            It was moved to Trash. An owner, editor, or workspace admin can restore it from the
            workspace Trash.
          </p>
        </>
      ) : isSignin ? (
        <>
          <p data-testid="no-access-title" className="font-serif text-base text-ink">
            Sign in to open this doc
          </p>
          <p className="text-sm text-muted">
            You may have access once you&rsquo;re signed in.
          </p>
          <Button
            type="button"
            data-testid="no-access-signin"
            className="mt-1"
            onClick={onSignIn}
            // slug is informational for callers/tests asserting the return target is the doc.
            data-return-slug={slug}
          >
            Sign in
          </Button>
        </>
      ) : (
        <>
          {/* Reused for BOTH a signed-in visitor with no access AND an anon visitor whose capability
              link is unknown / expired / turned off — so the copy must NOT assume a session. Warm +
              actionable, no status-code jargon. */}
          <p data-testid="no-access-title" className="font-serif text-base text-ink">
            This doc isn&rsquo;t available
          </p>
          <p className="text-sm text-muted">
            The share link may have expired or been turned off, or you may not have access. Ask the
            person who shared it to send you a new link.
          </p>
        </>
      )}
    </div>
  );
}
