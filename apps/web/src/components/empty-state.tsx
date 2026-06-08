// S-002: the shared no-data placeholder. web-core owns it so every feature screen reuses one
// empty surface (a successful response with nothing to show — distinct from <ErrorState>,
// which is for a failed request). Dark-operator tokens, muted text; teal accent on any CTA.
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="font-serif text-base text-ink">{title}</p>
      {description && <p className="text-sm text-muted">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
