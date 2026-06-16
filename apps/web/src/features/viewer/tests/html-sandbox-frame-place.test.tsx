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

/** Drive the iframe handshake and return the in-iframe port + a live list of highlight ids posted.
 *  S-003: the frame now sends the FULL set in ONE {type:'highlights'} batch (clear-then-redraw), so
 *  we accumulate the ids of EACH batch's items (the latest batch is the live set). */
function handshakeAndCollect(): { port: MessagePort; highlightIds: string[] } {
  const iframe = screen.getByTestId("html-sandbox-frame") as HTMLIFrameElement;
  const ch = new MessageChannel();
  const highlightIds: string[] = [];
  ch.port1.onmessage = (e: MessageEvent) => {
    const msg = e.data as { type?: string; items?: { annotationId: string }[] };
    if (msg?.type === "highlights" && Array.isArray(msg.items)) {
      for (const i of msg.items) highlightIds.push(i.annotationId);
    }
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

  it("AS-002: the highlight message carries the hue for a hued annotation", async () => {
    const iframe0 = "html-sandbox-frame";
    const hued = [
      { id: "h-amber", anchor: anchorOf("block-p-1"), hue: "#d68a3e" },
      { id: "h-none", anchor: anchorOf("block-p-2") },
    ];
    render(<HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={hued} />);
    const iframe = screen.getByTestId(iframe0) as HTMLIFrameElement;
    const ch = new MessageChannel();
    const byId: Record<string, string | undefined> = {};
    ch.port1.onmessage = (e: MessageEvent) => {
      // S-003: hue rides each item of the full-set {type:'highlights'} batch.
      const msg = e.data as { type?: string; items?: { annotationId: string; hue?: string }[] };
      if (msg?.type === "highlights" && Array.isArray(msg.items)) {
        for (const i of msg.items) byId[i.annotationId] = i.hue;
      }
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
    await waitFor(() => expect(Object.keys(byId).length).toBe(2));
    expect(byId["h-amber"]).toBe("#d68a3e");
    expect(byId["h-none"]).toBeUndefined();
  });

  it("AS-003: routes the bridge's place-failed (over the port) to the onPlaceFailed prop (no mark, no crash)", async () => {
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

// ---------------------------------------------------------------------------------------------
// S-003 — clear-then-redraw sync: the frame posts the FULL current set as ONE batch
// {type:'highlights'} on ready + on change, so a deleted id is excluded (its mark removed in-iframe).
// ---------------------------------------------------------------------------------------------

/** Drive the handshake and collect each {type:'highlights'} batch's id list, in arrival order. */
function handshakeAndCollectBatches(): { port: MessagePort; batches: string[][] } {
  const iframe = screen.getByTestId("html-sandbox-frame") as HTMLIFrameElement;
  const ch = new MessageChannel();
  const batches: string[][] = [];
  ch.port1.onmessage = (e: MessageEvent) => {
    const msg = e.data as { type?: string; items?: { annotationId: string }[] };
    if (msg?.type === "highlights" && Array.isArray(msg.items)) {
      batches.push(msg.items.map((i) => i.annotationId));
    }
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
  return { port: ch.port1, batches };
}

describe("HtmlSandboxFrame — full-set clear-then-redraw sync (S-003)", () => {
  it("AS-009 (C-002): posts the FULL current set as one {type:'highlights'} batch on ready", async () => {
    render(<HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={ANNOS} />);
    const { batches } = handshakeAndCollectBatches();
    await waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(1));
    // The latest batch carries the WHOLE set (idempotent — no per-id dribble, no dups/drops).
    expect([...batches.at(-1)!].sort()).toEqual(["a-1", "a-2"]);
  });

  it("AS-007: after an id is removed the new full-set batch EXCLUDES it (mark removed in-iframe)", async () => {
    const { rerender } = render(
      <HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={ANNOS} />,
    );
    const { batches } = handshakeAndCollectBatches();
    await waitFor(() => expect(batches.at(-1)).toBeDefined());

    // Delete a-2 → the set is now just a-1. The next batch must be exactly [a-1] (a-2 is gone, so
    // the clear-then-redraw drops its mark; a-1 stays).
    rerender(<HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={[ANNOS[0]!]} />);
    await waitFor(() => expect(batches.at(-1)).toEqual(["a-1"]));
    expect(batches.at(-1)).not.toContain("a-2");
  });

  it("AS-009: creating one amid existing leaves the others — the next batch is the full new set", async () => {
    const { rerender } = render(
      <HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={ANNOS} />,
    );
    const { batches } = handshakeAndCollectBatches();
    await waitFor(() => expect(batches.at(-1)).toBeDefined());

    const next = [...ANNOS, { id: "a-3", anchor: anchorOf("block-p-3") }];
    rerender(<HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={next} />);
    await waitFor(() => expect([...batches.at(-1)!].sort()).toEqual(["a-1", "a-2", "a-3"]));
  });

  it("AS-008: restoring a previously-removed id re-includes it in the next full-set batch", async () => {
    const { rerender } = render(
      <HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={[ANNOS[0]!]} />,
    );
    const { batches } = handshakeAndCollectBatches();
    await waitFor(() => expect(batches.at(-1)).toEqual(["a-1"]));
    // Restore a-2 → the next batch contains it again.
    rerender(<HtmlSandboxFrame contentUrl="/v/ver-html-1" onSelection={() => {}} annotations={ANNOS} />);
    await waitFor(() => expect([...batches.at(-1)!].sort()).toEqual(["a-1", "a-2"]));
  });
});
