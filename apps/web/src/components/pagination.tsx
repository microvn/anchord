// workspace-project-ui S-008 / C-007 — the shared numbered pagination control, reused by all
// three browse lists (All-docs, Projects, Search). Previous/Next plus a button per page; the
// current page reads as the accent, the others recede. Hidden entirely when the list fits one
// page (totalPages <= 1) so a short list shows no chrome. Dark-operator tokens (teal accent),
// responsive: the page-number row wraps and scrolls horizontally on narrow widths.

export function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  // C-007: a list that fits within one page (or is empty) shows NO control.
  if (totalPages <= 1) return null;

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  return (
    <nav
      data-testid="pagination"
      aria-label="Pagination"
      className="mt-5 flex flex-wrap items-center justify-center gap-1"
    >
      <button
        type="button"
        data-testid="pagination-prev"
        aria-label="Previous page"
        disabled={atFirst}
        onClick={() => onPageChange(page - 1)}
        className="inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-[12.5px] font-medium text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted"
      >
        Previous
      </button>
      <div className="flex max-w-full items-center gap-1 overflow-x-auto">
        {pages.map((n) => {
          const active = n === page;
          return (
            <button
              key={n}
              type="button"
              data-testid={`pagination-page-${n}`}
              aria-label={`Page ${n}`}
              aria-current={active ? "page" : undefined}
              onClick={() => onPageChange(n)}
              className={`grid size-8 flex-none place-items-center rounded-md border text-[12.5px] tabular-nums transition-colors ${
                active
                  ? "border-accent bg-accent-soft font-semibold text-accent-ink"
                  : "border-line bg-surface text-muted hover:text-ink"
              }`}
            >
              {n}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-testid="pagination-next"
        aria-label="Next page"
        disabled={atLast}
        onClick={() => onPageChange(page + 1)}
        className="inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-[12.5px] font-medium text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted"
      >
        Next
      </button>
    </nav>
  );
}
