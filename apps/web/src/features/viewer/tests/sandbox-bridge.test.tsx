import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-commenting S-002 — Comment on an HTML doc via the sandbox bridge.
//
// The HTML doc renders inside an opaque-origin sandboxed iframe; the parent can't read its DOM or
// selection. The backend injects an in-iframe bridge that, on load, hands the parent a transferred
// MessagePort (the "ready" handshake) and thereafter relays selections over that port. This suite
// covers the PARENT half (bridge.ts) at two levels:
//   1. the pure accept-predicate isTrustedReady (C-002) — unit;
//   2. connectBridge wiring with a real MessageChannel — integration;
//   3. the full compose flow in ViewerScreen for a kind=html doc (AS-004) + the forged-message
//      ignore (AS-005), with the viewer client MOCKED so we assert WRITE behaviour, not a round-trip.
//
// AS-004: selection inside the iframe relays over the trusted port → comment → createAnnotation +
//         highlight (relayed back over the port) + a top thread; write re-authorized server-side.
// AS-005: a forged parent.postMessage from the doc body (a window message, NOT the port) is ignored
//         — zero createAnnotation, no composer.

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

let docResponse: unknown;
let annoResponse: unknown;
let createResult: unknown;
let commentResult: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => annoResponse);
const createAnnotation = mock(async () => createResult);
const addComment = mock(async () => commentResult);

function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/services/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation,
  addComment,
  setResolution: mock(async () => ({ data: { success: true, data: { status: "resolved" } }, error: null })),
  canComment,
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
  Toaster: () => null,
}));

const { isTrustedReady, connectBridge } = await import("@/features/viewer/lib/bridge");
const { ViewerScreen } = await import("@/features/viewer/components/viewer-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App() {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-1/d/my-doc"]}>
        <Routes>
          <Route path="/w/:workspaceId/d/:slug" element={<ViewerScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// The anchor the bridge relays — a sentence in the "3rd block" of an HTML doc (AS-004 Data).
const HTML_ANCHOR = {
  blockId: "block-p-3",
  textSnippet: "The retry budget is three attempts.",
  offset: 0,
  length: "The retry budget is three attempts.".length,
};

beforeEach(() => {
  fetchViewerDoc.mockClear();
  listAnnotations.mockImplementation(async () => annoResponse);
  createAnnotation.mockClear();
  addComment.mockClear();
  toastError.mockClear();
  docResponse = okEnv({
    doc: {
      title: "HTML Spec",
      kind: "html",
      version: 2,
      status: "live",
      generalAccess: "restricted",
      effectiveRole: "commenter",
    },
    content: { contentUrl: "/v/ver-html-1" },
  });
  annoResponse = okRead({ items: [] });
  createResult = okEnv({ annotationId: "anno-real-1" });
  commentResult = okEnv({ commentId: "cmt-real-1" });
});

// ---------------------------------------------------------------------------------------------
// Level 1 — the pure accept-predicate (C-002). Unit-testable without a real cross-document source.
// ---------------------------------------------------------------------------------------------
describe("isTrustedReady (S-002 bridge accept-predicate)", () => {
  const cw = {}; // a stand-in for iframe.contentWindow
  const ch = new MessageChannel();
  const readyData = { source: "anchord-bridge", type: "ready", nonce: "n-1" };

  it("AS-004: accepts the ready whose source === iframe.contentWindow and carries a port", () => {
    const ev = { data: readyData, source: cw, ports: [ch.port2] };
    expect(isTrustedReady(ev, cw)).toBe(true);
  });

  it("C-002: rejects a ready whose source is NOT the iframe contentWindow (origin/source not trusted)", () => {
    const ev = { data: readyData, source: {}, ports: [ch.port2] };
    expect(isTrustedReady(ev, cw)).toBe(false);
  });

  it("AS-005: rejects a forged {annotation:…} window message even from the contentWindow", () => {
    const ev = { data: { annotation: { blockId: "x", textSnippet: "evil" } }, source: cw, ports: [ch.port2] };
    expect(isTrustedReady(ev, cw)).toBe(false);
  });

  it("C-002: rejects a ready with no transferred port (the port IS the transport)", () => {
    const ev = { data: readyData, source: cw, ports: [] as MessagePort[] };
    expect(isTrustedReady(ev, cw)).toBe(false);
  });

  it("AS-005: rejects a non-ready bridge message shape (e.g. a body-faked 'selection' on the window)", () => {
    const ev = { data: { source: "anchord-bridge", type: "selection", anchor: HTML_ANCHOR }, source: cw, ports: [ch.port2] };
    expect(isTrustedReady(ev, cw)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Level 2 — connectBridge wiring with a real MessageChannel + window listener.
// ---------------------------------------------------------------------------------------------
describe("connectBridge (S-002 parent transport)", () => {
  function handshake(contentWindow: unknown) {
    const ch = new MessageChannel();
    const ev = new window.MessageEvent("message", {
      data: { source: "anchord-bridge", type: "ready", nonce: "n-1" },
      source: contentWindow as Window,
      ports: [ch.port2],
    });
    return { ch, ev };
  }

  it("AS-004: a selection over the trusted port reaches onSelection with the relayed anchor", async () => {
    const contentWindow = {} as Window;
    const onSelection = mock(() => {});
    const conn = connectBridge({ contentWindow }, { onSelection });
    const { ch, ev } = handshake(contentWindow);
    window.dispatchEvent(ev);
    expect(conn.isConnected()).toBe(true);

    // The in-iframe end (ch.port1) posts a selection; the parent's port (ch.port2) delivers it.
    ch.port1.postMessage({ type: "selection", anchor: HTML_ANCHOR, rect: { x: 1, y: 2, width: 3, height: 4 } });
    await waitFor(() => expect(onSelection).toHaveBeenCalledTimes(1));
    expect(onSelection.mock.calls[0]![0]).toMatchObject({ blockId: "block-p-3", textSnippet: HTML_ANCHOR.textSnippet });
    expect(onSelection.mock.calls[0]![1]).toMatchObject({ x: 1, y: 2, width: 3, height: 4 });
    conn.dispose();
  });

  it("AS-004: a null-anchor selection over the port fires onClearSelection (selection cleared)", async () => {
    const contentWindow = {} as Window;
    const onSelection = mock(() => {});
    const onClearSelection = mock(() => {});
    const conn = connectBridge({ contentWindow }, { onSelection, onClearSelection });
    const { ch, ev } = handshake(contentWindow);
    window.dispatchEvent(ev);
    ch.port1.postMessage({ type: "selection", anchor: null });
    await waitFor(() => expect(onClearSelection).toHaveBeenCalledTimes(1));
    expect(onSelection).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("MƯỢT TASK 3: a selection-rect over the port reaches onSelectionRect (scroll re-anchor)", async () => {
    const contentWindow = {} as Window;
    const onSelectionRect = mock(() => {});
    const onClearSelection = mock(() => {});
    const conn = connectBridge({ contentWindow }, { onSelection: mock(() => {}), onSelectionRect, onClearSelection });
    const { ch, ev } = handshake(contentWindow);
    window.dispatchEvent(ev);
    // A scroll re-post with a rect repositions; a null rect (scrolled out) clears.
    ch.port1.postMessage({ type: "selection-rect", rect: { x: 5, y: 6, width: 7, height: 8 } });
    await waitFor(() => expect(onSelectionRect).toHaveBeenCalledTimes(1));
    expect(onSelectionRect.mock.calls[0]![0]).toMatchObject({ x: 5, y: 6, width: 7, height: 8 });
    ch.port1.postMessage({ type: "selection-rect", rect: null });
    await waitFor(() => expect(onClearSelection).toHaveBeenCalledTimes(1));
    conn.dispose();
  });

  it("AS-005: a forged window message (source !== contentWindow) never connects / never relays", async () => {
    const contentWindow = {} as Window;
    const onSelection = mock(() => {});
    const conn = connectBridge({ contentWindow }, { onSelection });
    // A body script posts a fake ready from a DIFFERENT source — must be rejected.
    const ch = new MessageChannel();
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { source: "anchord-bridge", type: "ready", nonce: "n-evil" },
        source: {} as Window, // NOT iframe.contentWindow
        ports: [ch.port2],
      }),
    );
    expect(conn.isConnected()).toBe(false);
    // Even if that rogue port tries to push a selection, the parent never bound to it.
    ch.port1.postMessage({ type: "selection", anchor: HTML_ANCHOR });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(onSelection).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("AS-005: after the handshake, a forged window message (not the port) is ignored", async () => {
    const contentWindow = {} as Window;
    const onSelection = mock(() => {});
    const conn = connectBridge({ contentWindow }, { onSelection });
    const { ev } = handshake(contentWindow);
    window.dispatchEvent(ev);
    expect(conn.isConnected()).toBe(true);

    // A body `parent.postMessage({...annotation...})` lands on the WINDOW, not the port — ignored.
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "selection", anchor: HTML_ANCHOR },
        source: contentWindow as Window,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(onSelection).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("AS-004: postHighlight sends a {type:'highlight'} message DOWN the port to the in-iframe bridge", async () => {
    const contentWindow = {} as Window;
    const conn = connectBridge({ contentWindow }, { onSelection: mock(() => {}) });
    const { ch, ev } = handshake(contentWindow);
    window.dispatchEvent(ev);
    let received: unknown = null;
    ch.port1.onmessage = (e: MessageEvent) => {
      received = e.data;
    };
    conn.postHighlight(HTML_ANCHOR, "anno-real-1");
    await waitFor(() => expect(received).not.toBeNull());
    expect(received).toMatchObject({ type: "highlight", annotationId: "anno-real-1", anchor: { blockId: "block-p-3" } });
    conn.dispose();
  });

  it("C-002: only the FIRST trusted ready binds the transport — a later ready is ignored", async () => {
    const contentWindow = {} as Window;
    const onSelection = mock(() => {});
    const conn = connectBridge({ contentWindow }, { onSelection });
    const first = handshake(contentWindow);
    window.dispatchEvent(first.ev);
    // A second ready (e.g. a body script racing the real bridge) — must NOT rebind the port.
    const second = handshake(contentWindow);
    window.dispatchEvent(second.ev);
    // The first port still works; the second port is dead to the parent.
    second.ch.port1.postMessage({ type: "selection", anchor: HTML_ANCHOR });
    await new Promise((r) => setTimeout(r, 10));
    expect(onSelection).not.toHaveBeenCalled();
    first.ch.port1.postMessage({ type: "selection", anchor: HTML_ANCHOR });
    await waitFor(() => expect(onSelection).toHaveBeenCalledTimes(1));
    conn.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// Level 3 — full ViewerScreen wiring for a kind=html doc.
// ---------------------------------------------------------------------------------------------

async function renderHtmlViewer() {
  render(<App />);
  await screen.findByTestId("html-sandbox-frame");
  await screen.findByTestId("annotations-rail");
}

/** Drive the iframe handshake against the rendered sandbox frame, returning its in-iframe port. */
function handshakeRenderedFrame(): MessagePort {
  const iframe = screen.getByTestId("html-sandbox-frame") as HTMLIFrameElement;
  const ch = new MessageChannel();
  act(() => {
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { source: "anchord-bridge", type: "ready", nonce: "n-1" },
        source: iframe.contentWindow as Window,
        ports: [ch.port2],
      }),
    );
  });
  return ch.port1; // the in-iframe side: post selections here, receive highlights here
}

describe("Sandbox bridge in ViewerScreen S-002", () => {
  it("C-009: the iframe src is set once from the doc's /v/:id contentUrl (not from message data)", async () => {
    await renderHtmlViewer();
    const iframe = screen.getByTestId("html-sandbox-frame") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe("/v/ver-html-1");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");

    // A handshake + a selection must NOT mutate the src — the bridge only reads selections.
    const port = handshakeRenderedFrame();
    port.postMessage({ type: "selection", anchor: HTML_ANCHOR, rect: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(iframe.getAttribute("src")).toBe("/v/ver-html-1");
  });

  it("AS-004: selecting inside the sandbox relays over the port → comment → createAnnotation + highlight + thread", async () => {
    const realAnnotation = {
      id: "anno-real-1",
      type: "range",
      status: "unresolved" as const,
      isOrphaned: false,
      anchor: { ...HTML_ANCHOR },
      comments: [
        { id: "cmt-real-1", parentId: null, authorName: "You", body: "Why three?", createdAt: new Date().toISOString() },
      ],
    };
    listAnnotations.mockImplementation(async () =>
      createAnnotation.mock.calls.length > 0 ? okRead({ items: [realAnnotation] }) : okRead({ items: [] }),
    );

    await renderHtmlViewer();
    const port = handshakeRenderedFrame();
    // The in-iframe bridge captures a highlight it's asked to draw (parent → port).
    let highlight: unknown = null;
    port.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === "highlight") highlight = e.data;
    };

    // The iframe relays the selection over the trusted port → the composer opens prefilled.
    act(() => {
      port.postMessage({ type: "selection", anchor: HTML_ANCHOR, rect: { x: 10, y: 20, width: 100, height: 16 } });
    });
    const popover = await screen.findByTestId("selection-popover");
    await userEvent.click(within(popover).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");
    expect(within(composer).getByTestId("pending-quote")).toHaveTextContent(HTML_ANCHOR.textSnippet);

    await userEvent.type(within(composer).getByTestId("composer-input"), "Why three?");
    await userEvent.click(within(composer).getByTestId("composer-send"));

    // AS-004.T1: a block-anchored create carries the relayed anchor; the write is server re-authz'd
    // (the body has no role/userId — identity rides the session; C-001).
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    // S-003: createAnnotation is now slug-only (slug, body) → the body is the 2nd arg.
    const [, createBody] = createAnnotation.mock.calls[0]!;
    expect(createBody.type).toBe("range");
    expect(createBody.anchor.blockId).toBe("block-p-3");
    expect(createBody.anchor.textSnippet).toBe(HTML_ANCHOR.textSnippet);
    expect(createBody.anchor.offset).toBe(0);

    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    // S-003: addComment is now (slug, annotationId, body) → annotationId is the 2nd arg.
    expect(addComment.mock.calls[0]![1]).toBe("anno-real-1");

    // AS-004.T2: the highlight is relayed DOWN the port (the parent can't draw into the opaque
    // iframe) with the real annotation id + the anchor.
    await waitFor(() => expect(highlight).not.toBeNull());
    expect(highlight).toMatchObject({ type: "highlight", annotationId: "anno-real-1", anchor: { blockId: "block-p-3" } });

    // AS-004.T3: exactly one thread (the reconciled real row) shows; the count is 1.
    await waitFor(() => expect(screen.getAllByTestId("thread-card")).toHaveLength(1));
    expect(screen.getAllByTestId("thread-card")[0]).toHaveTextContent("Why three?");
    expect(screen.getByTestId("rail-count")).toHaveTextContent("1");
  });

  it("AS-005: a forged postMessage from the doc body creates nothing and opens no composer", async () => {
    await renderHtmlViewer();
    // No handshake from the trusted contentWindow. A body script posts a forged annotation directly
    // on the parent window (parent.postMessage). It is NOT on the port and NOT a trusted ready.
    act(() => {
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "selection", anchor: HTML_ANCHOR, annotation: { ...HTML_ANCHOR } },
          source: {} as Window, // a forged source — not the iframe's contentWindow
        }),
      );
      // Also a forged ready from a wrong source — still ignored (C-002).
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { source: "anchord-bridge", type: "ready", nonce: "forged" },
          source: {} as Window,
          ports: [new MessageChannel().port2],
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 20));

    // C-001/AS-005: nothing created, no composer, no popover — the only create path is the
    // authorized client call, never a window message.
    expect(createAnnotation).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    expect(screen.getByTestId("rail-count")).toHaveTextContent("0");
  });

  it("AS-005 / C-004: a viewer-only role never wires the bridge — a relayed selection opens nothing", async () => {
    docResponse = okEnv({
      doc: {
        title: "HTML Spec",
        kind: "html",
        version: 2,
        status: "live",
        generalAccess: "restricted",
        effectiveRole: "viewer",
      },
      content: { contentUrl: "/v/ver-html-1" },
    });

    await renderHtmlViewer();
    // Even a "trusted" handshake + a real selection must do nothing for a read-only role: the frame
    // is rendered without onSelection, so connectBridge is never wired and the port is never bound.
    const port = handshakeRenderedFrame();
    act(() => {
      port.postMessage({ type: "selection", anchor: HTML_ANCHOR, rect: null });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(createAnnotation).not.toHaveBeenCalled();
  });
});
