import { memo } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";

// CapabilityLinkRow (capability-share-link S-005) — the EXTERNAL share link for an anyone-with-link
// doc: the unguessable `/s/<token>` capability address with a Copy control (AS-012). This is the link
// the owner hands to people OUTSIDE the workspace — the token IS the secret, so it carries no part of
// the doc title. It is rendered visibly DISTINCT from (and above) the in-app readable `/d/<slug>`
// address that LinkControls shows: this row gets the accent-soft, prominent treatment + an explicit
// "External share link" label so the owner copies the right one. Rendered only when the doc is
// anyone_with_link (the parent gates on `capabilityUrl` being present) — never for restricted /
// anyone_in_workspace (AS-013, the parent passes nothing then).

// The backend returns an origin-relative capability path (`/s/<token>`) so it stays correct on any
// self-host origin. Resolve it against the browser origin so the displayed + copied link is a
// pasteable absolute URL, mirroring LinkControls' absoluteShareUrl.
function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (typeof window === "undefined") return url;
  return new URL(url, window.location.origin).toString();
}

// Memoized: a single string prop, so it re-renders only when the capability URL itself changes
// (not on every parent render driven by tab/access/people state).
export const CapabilityLinkRow = memo(function CapabilityLinkRow({ capabilityUrl }: { capabilityUrl: string }) {
  const fullUrl = absoluteUrl(capabilityUrl);

  async function copy() {
    await navigator.clipboard?.writeText(fullUrl);
    toast.success("External link copied");
  }

  return (
    <section data-testid="share-sec-capability-link" className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-subtle">
        · External share link
      </span>
      <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
        <Icon name="link" size={14} />
        <code
          data-testid="share-capability-url"
          className="min-w-0 flex-1 truncate text-[12px] text-ink"
        >
          {fullUrl}
        </code>
        <button
          type="button"
          data-testid="share-capability-copy"
          onClick={() => void copy()}
          className="inline-flex h-7 flex-none items-center gap-1 rounded-[6px] border border-line px-2 text-[12px] font-medium text-accent transition-colors hover:text-accent-strong"
        >
          <Icon name="copy" size={13} /> Copy
        </button>
      </div>
      <span className="text-[11px] text-subtle">
        Anyone with this link can open the doc — it doesn&apos;t reveal the in-app address.
      </span>
    </section>
  );
});
