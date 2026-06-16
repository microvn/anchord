import { describe, it, expect, beforeEach } from "bun:test";
import { render, act, waitFor, screen } from "@testing-library/react";
import type { BridgeAnchor } from "@/features/viewer/lib/bridge";
import { HtmlSandboxFrame } from "@/features/viewer/components/html-sandbox-frame";

// HTML-PLACE (bug: HTML docs show every annotation "COULDN'T PLACE", no highlight).
//
// The fix: HtmlSandboxFrame must post EVERY existing annotation's anchor down the bridge once the
// handshake is ready, and re-post when the `annotations` prop changes. The light-DOM placer never
// runs for HTML (the doc blocks live inside the opaque iframe), so the bridge is the ONLY draw path.
//
// Uses the REAL bridge (no mock.module — that would leak the mock into sandbox-bridge.test.tsx and
// clobber the real connectBridge there). We drive a real MessageChannel handshake against the
// rendered iframe and collect the highlight messages the parent posts DOWN the in-iframe port.

const anchorOf = (block: string): BridgeAnchor => ({
  blockId: block,
  textSnippet: `snippet ${block}`,
  offset: 0,
  length: 7,
});

const ANNOS = [
  { id: "a-1", anchor: anchorOf("block-p-1") },
  { id: "a-2", anchor: anchorOf("block-p-2") },
];

/** Drive the iframe handshake and return the in-iframe port + a live list of highlight ids posted. */
function handshakeAndCollect(): { port: MessagePort; highlightIds: string[] } {
  const iframe = screen.getByTestId("html-sandbox-frame") as HTMLIFrameElement;
  const ch = new MessageChannel();
  const highlightIds: string[] = [];
  ch.port1.onmessage = (e: MessageEvent) => {
    const msg = e.data as { type?: string; annotationId?: string };
    if (msg?.type === "highlight" && typeof msg.annotationId === "string") highlightIds.push(msg.annotationId);
  };
  act(() => {
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { source: "anchord-bridge", type: "ready", nonce: "n-1" },
        source: iframe.contentWindow as Window,
        ports: [ch.port2],
      }),
    );
  });
  return { port: ch.port1, highlightIds };
}

beforeEach(() => {
  // jsdom MessagePort delivery is async; nothing to reset between tests here.
});

describe("HtmlSandboxFrame — post existing annotations to the bridge (HTML-PLACE)", () => {
  it("posts a highlight once per annotation after the bridge becomes ready", async () => {
    render(<HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={ANNOS} />);
    const { highlightIds } = handshakeAndCollect();
    await waitFor(() => expect(highlightIds.length).toBe(2));
    expect([...highlightIds].sort()).toEqual(["a-1", "a-2"]);
  });

  it("re-posts when the annotations prop changes after ready", async () => {
    const { rerender } = render(
      <HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={ANNOS} />,
    );
    const { highlightIds } = handshakeAndCollect();
    await waitFor(() => expect(highlightIds.length).toBe(2));

    const next = [...ANNOS, { id: "a-3", anchor: anchorOf("block-p-3") }];
    rerender(<HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={next} />);
    await waitFor(() => expect(highlightIds).toContain("a-3"));
  });

  it("routes the bridge's place-failed (over the port) to the onPlaceFailed prop", async () => {
    const failed: string[] = [];
    render(
      <HtmlSandboxFrame
        contentUrl="/v/ver-html-1"
        onSelection={() => {}}
        annotations={ANNOS}
        onPlaceFailed={(id) => failed.push(id)}
      />,
    );
    const { port } = handshakeAndCollect();
    act(() => {
      port.postMessage({ type: "place-failed", annotationId: "a-2" });
    });
    await waitFor(() => expect(failed).toEqual(["a-2"]));
  });
});
