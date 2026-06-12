import { memo } from "react";

// MarkdownView (S-001/AS-001, C-001): renders a kind=markdown doc INLINE in the app theme —
// NOT in an iframe. The HTML is already sanitized server-side (dompurify) and carries
// data-block-id markers, so the viewer renders it verbatim with dangerouslySetInnerHTML and
// does NOT re-sanitize or re-parse markdown client-side. The content sits in an app-origin,
// app-styled container so the doc is the high-contrast element (the rendered prose theme).
//
// BUG #1 (2026-06-12): annotation highlights are injected IMPERATIVELY as <mark data-anno> nodes
// by placeAnnotations, OUTSIDE React. React re-applies dangerouslySetInnerHTML on every re-render
// of the <article> — restoring the original __html and DELETING those marks. A text selection
// triggers a re-render of this subtree (the parent raises the selection popover), so every existing
// highlight vanished mid-selection. Memoizing on `html` means a re-render with the SAME html never
// re-commits innerHTML, so the imperatively-placed marks survive. (placeAnnotations stays the ONE
// owner of the marks; it only re-runs when the html or the annotation set actually changes.)
export const MarkdownView = memo(function MarkdownView({ html }: { html: string }) {
  return (
    <div className="px-5 pb-[120px] pt-[14px]">
      <article
        data-testid="markdown-view"
        // `.doc-prose` (styles.css) carries the doc typography + Wide/Focus max-width, matching
        // Anchord-Design viewer.css. The width mode is set on the docpane <main data-doc-width>.
        className="doc-prose text-ink"
        // Server-sanitized HTML (C-001/C-002): rendered in the app origin + app theme.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
});
