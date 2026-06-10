import type { ReactNode } from "react";
import { Brandmark } from "@/components/icon";
import { AuthAside } from "./auth-aside";

// Shared class strings that pin the shadcn primitives to the Anchord-Design `.auth*` spec
// (computed-style match). The shadcn Input/Label/Button defaults differ (14px text, px-3,
// rounded-md, font-medium) — these overrides bring each instance to the prototype's numbers
// WITHOUT mutating the shared primitives (used elsewhere in the app).

// `.auth-title` — Fraunces 28px / 500 / line-height 1.5 / -0.03em (prototype computes -0.84px;
// its runtime type tweak tightens beyond the static -.02em — match the rendered value).
export const authTitleClass =
  "font-serif text-[28px] font-medium leading-[1.5] tracking-[-0.03em] text-ink";
// `.auth-sub` — 13.5px (--t-body), muted, margin-top 7px.
export const authSubClass = "mt-[7px] text-[13.5px] text-muted";
// `.field-label` — 12.5px (--t-small) / 500 / ink (NOT muted).
export const authLabelClass = "text-[12.5px] font-medium text-ink";
// `.input` — h36 / px11 / 13.5px / surface bg / line border / radius 8 (override shadcn px3/14px/transparent).
export const authInputClass =
  "h-9 rounded-md border-line bg-surface px-[11px] py-0 text-[13.5px] text-ink md:text-[13.5px] dark:bg-surface";
// `.btn.primary.lg.block` — h40 / px16 / 13.5px / 600 / radius 11 / full-width / margin-top 4.
export const authSubmitClass =
  "mt-1 h-10 w-full rounded-[11px] px-4 text-[13.5px] font-semibold";
// `.auth-foot` — 12.5px (--t-small), muted, centered, margin-top 22.
export const authFootClass = "mt-[22px] text-center text-[12.5px] text-muted";

// AuthShell — the two-pane auth layout (Anchord-Design `.auth`): a left form pane (centered
// Card-width column, max 360px) + the right brand AuthAside. The aside collapses below ~820px
// so mobile renders the form alone. The form pane carries the brand lockup above the slot;
// each screen (sign-in/up) fills `children` with its title + form.
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 bg-paper min-[820px]:grid-cols-2">
      <div className="flex min-w-0 flex-col justify-center px-5 py-7 min-[600px]:p-12">
        <div className="mx-auto w-full max-w-[360px]">
          <div className="mb-[30px] flex items-center gap-2.5">
            <Brandmark size={22} />
            <span className="font-serif text-[19px] font-medium tracking-[-0.03em] text-ink">
              anchord
            </span>
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
