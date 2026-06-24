import { ForYouContent } from "@/features/your-activity/components/for-you-content";

// your-activity-inbox S-001 — the account-scoped `/me/activity` page (a sibling of `/settings`,
// rendered inside the app shell). SINGLE-SURFACE (M7 / Overview, supersedes C-004): it renders the
// For-you content DIRECTLY, with NO tab bar and NO empty "Your actions" tab — a dead tab is UX debt.
// The sibling spec `your-activity-actions` (2b) introduces the two-tab bar later and composes
// `ForYouContent` as tab 1.
//
// The header subtitle names the cross-workspace nature WITHOUT promising "mentions" (C-005 —
// mentions are a separate spec 3 with no backend yet).

export function YourActivityPage() {
  return (
    <section
      className="mx-auto max-w-[760px] px-6 py-8"
      data-testid="your-activity-page"
    >
      <header className="mb-[22px]">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-subtle">
          Account
        </div>
        <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
          Your activity
        </h1>
        <p className="mt-2 text-sm text-muted">
          Replies and feedback across every workspace you’re in.
        </p>
      </header>

      <ForYouContent />
    </section>
  );
}
