import { useEffect } from "react";

// Client-side per-page document metadata. The app is a Vite SPA served from a static
// index.html, so titles/description are set here at render time (React 19 could hoist
// <title>/<meta>, but a hook survives the loading/error early-returns every screen has —
// the title is correct even before data resolves). Non-JS crawlers/social unfurlers still
// see index.html's defaults; per-doc server-side OG injection is deliberately out of scope.
const SITE_NAME = "anchord";
const DEFAULT_DESCRIPTION =
  "Self-hosted platform to share and annotate AI-generated docs — own your data, comment in the margin, pull feedback back via MCP.";

/**
 * Set the browser tab title (and the <meta name="description"> tag) for the current page.
 * Pass a page-specific `title` ("Documents") → renders "Documents · anchord"; omit it on the
 * root/redirect screens → bare "anchord". `description` falls back to the site default so the
 * description tag is always present and never stale across client-side navigations.
 */
export function usePageMeta(title?: string, description?: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${SITE_NAME}` : SITE_NAME;

    let tag = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "description");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", description ?? DEFAULT_DESCRIPTION);
  }, [title, description]);
}
