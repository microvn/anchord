import { useEffect, useState } from "react";

// S-006 / AS-022: the loading skeleton — grey `elev` rows matching the list shape, NOT a
// centered full-page spinner. web-core owns it so every list screen reuses one calm loading
// surface. A load under ~300ms renders NOTHING (avoid a flash): the `delayMs` guard holds the
// skeleton back until the threshold elapses, so a fast fetch resolves to content with no flicker.
//
// Usage: render <Skeleton/> while a query is loading; the consumer swaps in the real list once
// the data arrives. `rows` controls how many shape-matching rows to draw.
export function Skeleton({
  rows = 3,
  delayMs = 300,
}: {
  rows?: number;
  delayMs?: number;
}) {
  // Below the threshold show nothing; flip visible once the delay elapses.
  const [visible, setVisible] = useState(delayMs <= 0);

  useEffect(() => {
    if (delayMs <= 0) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const id = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);

  if (!visible) return null;

  return (
    <div
      data-testid="skeleton"
      aria-hidden="true"
      className="flex flex-col gap-3 px-1 py-2"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          data-skeleton-row
          className="h-12 animate-pulse rounded-md bg-elev"
        />
      ))}
    </div>
  );
}
