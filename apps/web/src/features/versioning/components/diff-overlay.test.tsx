import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// versioning-diff-ui S-003 — the compare-two-versions DiffOverlay. The diff read goes through the
// feature client (`getDiff`), which we MOCK here; the overlay reaches it via the `useDiff` hook →
// `useApiQuery`, which peels the api-core success envelope. So the mock returns the RAW Eden
// `{ data: <envelope>, error }` shape, matching what treaty delivers.
//
// AS-007: Source tab line-diff — added rows teal-styled, removed rows red + struck through, monospace;
//   header shows +adds/−removed (data: v3→v4, 3 added / 1 removed).
// AS-008: Rendered tab — two panes (before=v3 | after=v4), each iframe fed its version's renderPair url.
// AS-009: changing the `from` picker re-fetches with the new from (GET …/diff?from=2&to=4).
// AS-010: responsive — the rendered pair stacks ≤760 (pure renderedPairStacks).
// AS-011: a refused diff shows an error state (role=alert), never a blank/half diff.
// C-004 folds into AS-007's assertions.

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });

const TEXT_DIFF = okEnv({
  mode: "text",
  identical: false,
  changeCount: 4,
  lines: [
    { type: "context", text: "# Title" },
    { type: "added", text: "new line one" },
    { type: "added", text: "new line two" },
    { type: "added", text: "new line three" },
    { type: "removed", text: "old removed line" },
  ],
  renderPair: ["/v/idA", "/v/idB"],
});

// S-004 fixtures. IDENTICAL: changeCount 0, all-context lines, identical:true, mode text, renderPair
// still present (AS-012 — the Rendered tab stays available). IMAGE: mode image, no lines/changeCount.
const IDENTICAL_DIFF = okEnv({
  mode: "text",
  identical: true,
  changeCount: 0,
  lines: [
    { type: "context", text: "# Title" },
    { type: "context", text: "unchanged body" },
  ],
  renderPair: ["/v/idA", "/v/idB"],
});
const IMAGE_DIFF = okEnv({
  mode: "image",
  renderPair: ["/v/imgA", "/v/imgB"],
});

const getDiff = mock(async () => TEXT_DIFF as unknown);
const getVersionHistory = mock(async () => okEnv({ items: [], pagination: {} }) as unknown);
const restoreVersion = mock(async () => okEnv({ version: 5, previousVersion: 4 }) as unknown);
mock.module("@/features/versioning/services/client", () => ({
  getDiff,
  getVersionHistory,
  restoreVersion,
}));

const { DiffOverlay } = await import("@/features/versioning/components/diff-overlay");
const { renderedPairStacks } = await import("@/features/versioning/components/rendered-pair");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function renderOverlay(props: Partial<Parameters<typeof DiffOverlay>[0]> = {}) {
  const onClose = mock(() => {});
  render(
    <QueryClientProvider client={client()}>
      <DiffOverlay
        slug="my-doc"
        versions={[4, 3, 2, 1]}
        initialFrom={3}
        initialTo={4}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  getDiff.mockClear();
  getDiff.mockImplementation(async () => TEXT_DIFF as unknown);
});

describe("versioning-diff-ui S-003 — DiffOverlay", () => {
  it("AS-007 / C-003: Source tab shows a line-diff (added teal / removed red-strike, mono) + a +adds/−removed change count (two-level diff)", async () => {
    renderOverlay();

    const diff = await screen.findByTestId("source-line-diff");

    // The header change count reports +3 / −1 (3 added, 1 removed in the fixture).
    const count = screen.getByTestId("diff-count");
    expect(count).toHaveTextContent("+3");
    expect(count).toHaveTextContent("−1");

    // Added rows carry the added marker/style; removed rows the removed + strikethrough style.
    const added = within(diff).getAllByText(/^new line/);
    expect(added.length).toBe(3);
    const addedRow = added[0].closest("[data-line-type]");
    expect(addedRow).toHaveAttribute("data-line-type", "added");
    expect(addedRow?.className).toContain("accent");

    const removedRow = within(diff).getByText("old removed line").closest("[data-line-type]");
    expect(removedRow).toHaveAttribute("data-line-type", "removed");
    expect(removedRow?.className).toContain("line-through");

    // Monospace body.
    expect(diff.querySelector(".font-mono")).not.toBeNull();
  });

  it("AS-008: Rendered tab shows two panes (before=v3 | after=v4), each iframe fed its renderPair url", async () => {
    renderOverlay();
    await screen.findByTestId("source-line-diff");

    fireEvent.click(screen.getByTestId("diff-tab-rendered"));

    const pair = await screen.findByTestId("rendered-pair");
    const before = within(pair).getByTestId("rp-frame-before");
    const after = within(pair).getByTestId("rp-frame-after");

    // before pane = renderPair[0], after pane = renderPair[1], in before|after order.
    expect(before).toHaveAttribute("src", "/v/idA");
    expect(after).toHaveAttribute("src", "/v/idB");

    // each pane is labelled with its version.
    expect(within(pair).getByTestId("rp-col-before")).toHaveTextContent("v3");
    expect(within(pair).getByTestId("rp-col-after")).toHaveTextContent("v4");
  });

  it("AS-009: changing the `from` picker re-fetches the diff with the new from", async () => {
    renderOverlay();
    await screen.findByTestId("source-line-diff");

    // Initial fetch was for from=3. S-005: getDiff(slug, from, to) — from at index 1, to at index 2.
    await waitFor(() => expect(getDiff).toHaveBeenCalled());
    const firstFroms = getDiff.mock.calls.map((c) => c[1]);
    expect(firstFroms).toContain(3);

    // Change `from` to v2 → a new fetch fires with from=2 (and to stays 4).
    fireEvent.change(screen.getByTestId("diff-from"), { target: { value: "2" } });

    await waitFor(() => {
      const called = getDiff.mock.calls.some((c) => c[1] === 2 && c[2] === 4);
      expect(called).toBe(true);
    });
  });

  it("AS-011: a refused diff shows an error state (role=alert), never a blank/half diff", async () => {
    getDiff.mockImplementation(async () => ({ data: null, error: { status: 404, message: "no such version" } }));
    renderOverlay();

    await screen.findByTestId("diff-error", {}, { timeout: 4000 });
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load this comparison/i);

    // No diff body is rendered alongside the error.
    expect(screen.queryByTestId("source-line-diff")).toBeNull();
    expect(screen.queryByTestId("rendered-pair")).toBeNull();
  });
});

describe("AS-010 / C-006 — rendered pair stacks ≤760 (pure)", () => {
  it("AS-010: ≤760px stacks vertically, >760px stays side-by-side", () => {
    expect(renderedPairStacks(360)).toBe(true);
    expect(renderedPairStacks(760)).toBe(true);
    expect(renderedPairStacks(761)).toBe(false);
    expect(renderedPairStacks(1440)).toBe(false);
  });
});

describe("versioning-diff-ui S-004 — DiffOverlay no-diff + image states", () => {
  it("AS-012: identical versions show 'No differences' on Source (count 0) BUT keep the Rendered tab, which renders both side-by-side", async () => {
    getDiff.mockImplementation(async () => IDENTICAL_DIFF as unknown);
    renderOverlay();

    // Source tab body: a "No differences" state with both version labels (NOT an empty line-diff).
    const noDiff = await screen.findByTestId("no-diff");
    expect(noDiff).toHaveTextContent(/no differences/i);
    expect(noDiff).toHaveTextContent("v3");
    expect(noDiff).toHaveTextContent("v4");
    expect(screen.queryByTestId("source-line-diff")).toBeNull();

    // Change count is 0 (+0 / −0).
    const count = screen.getByTestId("diff-count");
    expect(count).toHaveTextContent("+0");
    expect(count).toHaveTextContent("−0");

    // C-005 / AS-012: the tabs are NOT hidden — the Rendered tab is present and clickable.
    const tabs = screen.getByTestId("diff-tabs");
    const rendered = within(tabs).getByTestId("diff-tab-rendered");
    fireEvent.click(rendered);

    // Switching to Rendered renders BOTH panes side-by-side from the renderPair (still shown).
    const pair = await screen.findByTestId("rendered-pair");
    expect(within(pair).getByTestId("rp-frame-before")).toHaveAttribute("src", "/v/idA");
    expect(within(pair).getByTestId("rp-frame-after")).toHaveAttribute("src", "/v/idB");
  });

  it("AS-013 / C-005: an image doc shows the two images side-by-side using renderPair AND renders NO Source tab / line-diff", async () => {
    getDiff.mockImplementation(async () => IMAGE_DIFF as unknown);
    renderOverlay();

    // Two image panes side-by-side, each fed its renderPair url, in before|after order with labels.
    const pair = await screen.findByTestId("image-diff-pair");
    expect(within(pair).getByTestId("idp-img-before")).toHaveAttribute("src", "/v/imgA");
    expect(within(pair).getByTestId("idp-img-after")).toHaveAttribute("src", "/v/imgB");
    expect(within(pair).getByTestId("idp-col-before")).toHaveTextContent("v3");
    expect(within(pair).getByTestId("idp-col-after")).toHaveTextContent("v4");

    // C-005: NO Source tab (the tabs are dropped entirely for an image doc) and NO line-diff.
    expect(screen.queryByTestId("diff-tabs")).toBeNull();
    expect(screen.queryByTestId("diff-tab-source")).toBeNull();
    expect(screen.queryByTestId("source-line-diff")).toBeNull();
    expect(screen.queryByTestId("rendered-pair")).toBeNull();
  });
});
