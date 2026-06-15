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
//
// Chrome recedes (DESIGN.md): a centered, low-chrome panel; the only accent is the single teal CTA
// on the sign-in variant. Responsive — a max-width centered column that holds at 360/768/1024/1440.

export type NoAccessVariant = "signin" | "no-access";

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
        <Icon name="shield" size={20} />
      </span>
      {isSignin ? (
        <>
          <p data-testid="no-access-title" className="font-serif text-base text-ink">
            Sign in to view this doc
          </p>
          <p className="text-sm text-muted">
            This document is restricted. Signing in might give you access.
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
          <p data-testid="no-access-title" className="font-serif text-base text-ink">
            You don&rsquo;t have access
          </p>
          <p className="text-sm text-muted">
            You&rsquo;re signed in, but this document isn&rsquo;t shared with your account.
          </p>
        </>
      )}
    </div>
  );
}
