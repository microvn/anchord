import { describe, it, expect, mock, afterEach } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { EmptyState } from "../src/components/empty-state";
import { NoResultsState } from "../src/components/no-results-state";
import { ErrorState } from "../src/components/error-state";
import { Skeleton } from "../src/components/skeleton";

// web-core S-006 — empty, no-results, loading, and error states. These are the shared
// presentational primitives every feature screen reuses; C-007 requires the four states to
// be DISTINCT (empty ≠ no-results; loading = skeleton; error = recoverable + retry).
// Pixel/visual checks are [→MANUAL]; the logic (which action shows, distinctness, retry/clear
// callbacks, the sub-300ms delay gate) is unit-tested here.

afterEach(() => {
  mock.restore();
});

describe("web-core S-006 — empty/no-results/loading/error states", () => {
  // AS-020: an empty data view shows a low-key type-only state with ONE primary create
  // action ≥40px and NO decorative illustration.
  it("AS-020: empty view renders one primary create action ≥40px and no illustration", () => {
    const { container } = render(
      <EmptyState
        title="No projects yet"
        description="Create your first project to get started."
        action={
          <button type="button" className="min-h-[40px]">
            Create project
          </button>
        }
      />,
    );
    // type-only state: the title + description text is present.
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    // exactly one primary action (the create CTA), and it meets the ≥40px tap target.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveClass("min-h-[40px]");
    expect(buttons[0]).toHaveTextContent("Create project");
    // no decorative illustration: no <img>, <svg>, or role=img in the empty state.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  // AS-021: a no-results state names the query, offers Clear search, fires the clear callback,
  // and does NOT show the create CTA — distinct from the empty state (C-007).
  it("AS-021: no-results names the query, offers Clear search (fires callback), and is distinct from empty (no create CTA)", () => {
    let cleared = 0;
    render(<NoResultsState query="invoices" onClear={() => (cleared += 1)} />);
    // it names the query the user typed.
    expect(screen.getByText(/invoices/)).toBeInTheDocument();
    // the only action is Clear search — NOT a create CTA.
    const clear = screen.getByRole("button", { name: /clear search/i });
    expect(screen.queryByRole("button", { name: /create|new|publish|invite/i })).toBeNull();
    act(() => clear.click());
    expect(cleared).toBe(1);
  });

  // AS-021 / C-007 distinctness: empty offers a create CTA; no-results does not, and instead
  // offers Clear search. Assert the two states render different actions for the same screen.
  it("C-007: empty (create CTA) and no-results (Clear search) are distinct states", () => {
    const { rerender } = render(
      <EmptyState
        title="No docs yet"
        action={<button type="button">Publish a doc</button>}
      />,
    );
    expect(screen.getByRole("button", { name: /publish a doc/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear search/i })).toBeNull();

    rerender(<NoResultsState query="report" onClear={() => {}} />);
    expect(screen.getByRole("button", { name: /clear search/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /publish a doc/i })).toBeNull();
  });

  // AS-022: loading shows a skeleton matching the list shape — NOT a centered full-page spinner.
  it("AS-022: loading renders a skeleton matching the list shape, not a spinner", () => {
    const { container } = render(<Skeleton rows={4} delayMs={0} />);
    const list = container.querySelector('[data-testid="skeleton"]');
    expect(list).not.toBeNull();
    // shape-matching: one skeleton row per list item.
    expect(container.querySelectorAll('[data-skeleton-row]')).toHaveLength(4);
    // no spinner role / status spinner.
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  // AS-022: a load under ~300ms shows NOTHING (avoid flash); past the delay the skeleton
  // appears. Driven deterministically via a delay prop + fake timers (no real waits).
  it("AS-022: a sub-threshold load renders nothing, then the skeleton after the delay", () => {
    const realNow = Date.now;
    let now = 0;
    const timers: Array<{ id: number; fn: () => void; at: number }> = [];
    let nextId = 1;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    // deterministic clock: setTimeout schedules against a virtual `now`.
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fn, at: now + (ms ?? 0) });
      return id;
    }) as unknown as typeof setTimeout;
    (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = ((id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    }) as unknown as typeof clearTimeout;
    Date.now = () => now;
    const advance = (ms: number) => {
      now += ms;
      act(() => {
        for (const t of [...timers]) {
          if (t.at <= now) {
            timers.splice(timers.indexOf(t), 1);
            t.fn();
          }
        }
      });
    };
    try {
      const { container } = render(<Skeleton rows={3} delayMs={300} />);
      // before the delay elapses: nothing rendered (avoid a flash on a fast load).
      expect(container.querySelector('[data-testid="skeleton"]')).toBeNull();
      // a sub-threshold elapse (250ms) still shows nothing.
      advance(250);
      expect(container.querySelector('[data-testid="skeleton"]')).toBeNull();
      // past the threshold the skeleton appears.
      advance(60);
      expect(container.querySelector('[data-testid="skeleton"]')).not.toBeNull();
    } finally {
      Date.now = realNow;
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
      (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
    }
  });

  // AS-023: a failed load renders a recoverable error with a Retry that fires the retry
  // callback, and is visually/behaviorally distinct from the empty state (role=alert + Retry,
  // never a create CTA).
  it("AS-023: error renders a Retry that fires the retry callback and is distinct from empty", () => {
    let retried = 0;
    render(<ErrorState message="Couldn't load docs." onRetry={() => (retried += 1)} />);
    // recoverable error surface, distinct from empty: it is an alert with the error text.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load docs.");
    const retry = screen.getByRole("button", { name: /retry/i });
    // distinct from empty: no create CTA on an error.
    expect(screen.queryByRole("button", { name: /create|new|publish/i })).toBeNull();
    act(() => retry.click());
    expect(retried).toBe(1);
  });
});
