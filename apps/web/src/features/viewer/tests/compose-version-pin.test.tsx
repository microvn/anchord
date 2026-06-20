import { describe, it, expect, mock, afterAll, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

// annotation-create-version-pin S-001 (AS-005 / C-001 / C-002): the viewer create sends
// `expectedVersion` = the version it RENDERED; on a STALE refusal (409) it reloads the doc +
// annotations, KEEPS the user's draft comment, and surfaces a "document changed — reloaded" message
// (the annotation is NOT silently lost). Driven through useCompose.send (the real create seam).
//
// bun mock.module is GLOBAL + persistent (project memory: bun-mockmodule-leak) — `createAnnotation`
// is a mutable mock flipped per-test and reset in afterAll so it can't leak into sibling files.

const toastSpy = Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) });
mock.module("sonner", () => ({ toast: toastSpy, Toaster: () => null }));

// The mutable create mock: default success; the stale test flips it to a 409.
let createAnnotationMock = mock(async (..._args: unknown[]) => ({ data: { annotationId: "a1" }, error: null }));
const createAnnotationCalls: unknown[][] = [];
mock.module("@/features/viewer/services/client", () => ({
  createRedline: mock(async () => ({ data: { success: true, data: { suggestionId: "rl-x" } }, error: null })),
  decideSuggestion: mock(async () => ({ data: { success: true, data: { status: "accepted" } }, error: null })),
  createAnnotation: mock(async (...args: unknown[]) => {
    createAnnotationCalls.push(args);
    return createAnnotationMock(...args);
  }),
  addComment: mock(async () => ({ data: {}, error: null })),
  deleteAnnotation: mock(async () => ({ data: { success: true, data: { deleted: true } }, error: null })),
  restoreAnnotation: mock(async () => ({ data: { success: true, data: { restored: true } }, error: null })),
  dismissAnnotation: mock(async () => ({ data: { success: true, data: { dismissed: true } }, error: null })),
  reattachAnnotation: mock(async () => ({ data: { success: true, data: { isOrphaned: false } }, error: null })),
}));

const { useCompose } = await import("@/features/viewer/hooks/use-compose");

afterAll(() => {
  // Reset the global module mock so this file's stale/success stubs don't leak into sibling tests.
  createAnnotationMock = mock(async () => ({ data: { annotationId: "a1" }, error: null }));
});

beforeEach(() => {
  createAnnotationCalls.length = 0;
});

const RENDERED_VERSION = 4;

/** Build a doc pane with one block, select chars [start,end), return the pane element. */
function buildPaneWithSelection(start: number, end: number): HTMLElement {
  const pane = document.createElement("main");
  pane.innerHTML = '<p id="block-p-1">Payment expires after 24h</p>';
  document.body.appendChild(pane);
  const p = pane.querySelector("p")!;
  const range = document.createRange();
  range.setStart(p.firstChild!, start);
  range.setEnd(p.firstChild!, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return pane;
}

/** Render useCompose with redlineCtx pinned at RENDERED_VERSION + a recording onStaleCreate. */
function renderCompose(onStaleCreate: () => void) {
  const pane = buildPaneWithSelection(8, 15); // "expires"
  const hook = renderHook(() =>
    useCompose(
      "doc-one",
      pane,
      true, // canCompose
      { workspaceId: "ws_1", version: RENDERED_VERSION }, // the version the viewer rendered
      () => {}, // onCreatedAnnotation
      undefined, // onCreated
      { id: "u-1", name: "Demo" }, // currentUser
      false, // canEditDoc
      onStaleCreate,
    ),
  );
  return { hook, pane };
}

/** Drive selection → popover → composer so `active` is set, then return the hook result. */
function armComposer(result: ReturnType<typeof renderHook>["result"], pane: HTMLElement) {
  act(() => {
    pane.dispatchEvent(new Event("mouseup", { bubbles: true }));
  });
  act(() => {
    (result.current as { startComment: () => void }).startComment();
  });
}

describe("annotation-create-version-pin S-001 (AS-005): the viewer pins create to the rendered version", () => {
  it("AS-005: create sends expectedVersion = the rendered doc version", async () => {
    const { hook, pane } = renderCompose(() => {});
    armComposer(hook.result, pane);
    await act(async () => {
      (hook.result.current as { send: (b: string) => void }).send("this looks off");
      await waitFor(() => expect(createAnnotationCalls.length).toBe(1));
    });
    const [, body] = createAnnotationCalls[0] as [string, { expectedVersion?: number }];
    expect(body.expectedVersion).toBe(RENDERED_VERSION); // C-001: the version it rendered
    pane.remove();
  });

  it("AS-005/C-002: on a STALE refusal (409) the viewer reloads + keeps the draft + surfaces a message", async () => {
    // Flip the create to refuse with a 409 (the server's stale ConflictError shape).
    createAnnotationMock = mock(async () => ({ data: null, error: { status: 409, value: { error: { details: { currentVersion: 5 } } } } }));
    const onStaleCreate = mock(() => {});
    const { hook, pane } = renderCompose(onStaleCreate);
    armComposer(hook.result, pane);

    await act(async () => {
      (hook.result.current as { send: (b: string) => void }).send("my unsaved draft");
      await waitFor(() => expect(onStaleCreate).toHaveBeenCalledTimes(1));
    });

    // C-002 / AS-005: the reload signal fired (the screen invalidates the two queries + toasts).
    expect(onStaleCreate).toHaveBeenCalledTimes(1);
    // The annotation is NOT silently lost — the composer re-opens with the SAME draft body + anchor.
    await waitFor(() => {
      const cur = hook.result.current as { quote: string | null; composeInitialBody: string; composerAnchor: unknown };
      expect(cur.composeInitialBody).toBe("my unsaved draft"); // draft preserved
      expect(cur.quote).toBe("expires"); // the re-selected quote is restored, not cleared
      expect(cur.composerAnchor).not.toBeNull(); // composer re-opened, not closed
    });
    pane.remove();
  });
});
