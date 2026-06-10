import type { ReactNode } from "react";
import { Brandmark } from "@/components/icon";
import { AuthAside } from "./auth-aside";

// AuthShell — the two-pane auth layout (Anchord-Design `.auth`): a left form pane (centered
// Card-width column, max 360px) + the right brand AuthAside. The aside collapses below ~820px
// so mobile renders the form alone. The form pane carries the brand lockup above the slot;
// each screen (sign-in/up) fills `children` with its title + form.
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 bg-paper lg:grid-cols-2">
      <div className="flex min-w-0 flex-col justify-center px-5 py-7 md:p-12">
        <div className="mx-auto w-full max-w-[360px]">
          <div className="mb-[30px] flex items-center gap-2.5">
            <Brandmark size={22} />
            <span className="font-serif text-[19px] tracking-tight text-ink">anchord</span>
          </div>
          {children}
        </div>
      </div>
      <AuthAside />
    </div>
  );
}

// AuthCenter — the centered single-panel layout for the verify / invite landings
// (Anchord-Design `.auth-center` + `.auth-panel`): one column, place-items-center, a
// max-420px panel. Used by VerifyEmailLanding, VerifyEmailSent, and both invite landings.
export function AuthCenter({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-6 py-12">
      <div className="w-full max-w-[420px] text-center">{children}</div>
    </main>
  );
}
