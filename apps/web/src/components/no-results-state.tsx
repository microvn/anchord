// S-006 / AS-021: the no-results surface — DISTINCT from <EmptyState> (C-007). Empty means a
// data set has nothing yet (→ a create CTA); no-results means a query matched nothing (→ name
// the query + offer Clear search, NO create CTA). web-core owns it so every searchable feature
// screen reuses one no-results surface. Type-only, dark-operator tokens, no illustration.
import { Button } from "./ui/button";

export function NoResultsState({
  query,
  onClear,
  description,
}: {
  query: string;
  onClear: () => void;
  description?: string;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="font-serif text-base text-ink">
        No matches for “{query}”
      </p>
      <p className="text-sm text-muted">
        {description ?? "Try a different search, or clear it to see everything."}
      </p>
      <Button type="button" variant="secondary" onClick={onClear} className="mt-1">
        Clear search
      </Button>
    </div>
  );
}
