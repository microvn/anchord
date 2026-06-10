import { Icon } from "../../components/icon";

// HtmlSandboxFrame (S-001/AS-002, C-001/C-008): renders a kind=html doc inside a sandboxed
// iframe whose `src` is the backend's /v/:id content route (opaque origin, own styles, scripts
// isolated). The app chrome NEVER restyles the framed content — that is the whole point of the
// isolation. `sandbox="allow-scripts"` (no allow-same-origin) keeps the framed doc on an opaque
// origin so it can't reach the app's cookies/DOM (render-publish C-001/C-002). The /v path is
// proxied to the backend in dev (vite.config), so this relative src resolves same-origin in prod
// and dev alike.

export function HtmlSandboxFrame({ contentUrl }: { contentUrl: string }) {
  return (
    <div className="px-5 pb-[120px] pt-[14px]">
      <div className="mx-auto max-w-[760px]">
        <div className="mb-3 flex items-center gap-2 text-xs text-subtle">
          <Icon name="shield" size={14} />
          <span className="font-mono uppercase tracking-[0.06em]">
            Isolated sandbox · opaque origin · author styles preserved
          </span>
        </div>
        <iframe
          data-testid="html-sandbox-frame"
          className="h-[560px] w-full rounded-md border border-line bg-white"
          sandbox="allow-scripts"
          src={contentUrl}
          title="doc"
        />
      </div>
    </div>
  );
}
