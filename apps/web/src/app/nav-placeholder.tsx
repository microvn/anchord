// NavPlaceholder (web-core S-004 / GAP-002): the sidebar nav destinations (Dashboard · All docs ·
// Projects · Activity) and `+ New doc` route to SCREENS owned by workspace-project-ui, which is
// not built yet. web-core frames the nav + routes to it regardless; until the real screen ships,
// the route lands here — an empty placeholder view, never a blank/crashed page. Replaced when
// workspace-project-ui delivers each destination.
export function NavPlaceholder({ title }: { title: string }) {
  return (
    <div className="px-6 py-10" data-testid="nav-placeholder">
      <h1 className="font-serif text-lg text-ink">{title}</h1>
      <p className="mt-2 text-sm text-muted">Coming soon.</p>
    </div>
  );
}
