// MarkdownView (S-001/AS-001, C-001): renders a kind=markdown doc INLINE in the app theme —
// NOT in an iframe. The HTML is already sanitized server-side (dompurify) and carries
// data-block-id markers, so the viewer renders it verbatim with dangerouslySetInnerHTML and
// does NOT re-sanitize or re-parse markdown client-side. The content sits in an app-origin,
// app-styled container so the doc is the high-contrast element (the rendered prose theme).

export function MarkdownView({ html }: { html: string }) {
  return (
    <div className="px-5 pb-[120px] pt-[14px]">
      <article
        data-testid="markdown-view"
        className="prose mx-auto max-w-[760px] text-ink"
        // Server-sanitized HTML (C-001/C-002): rendered in the app origin + app theme.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
