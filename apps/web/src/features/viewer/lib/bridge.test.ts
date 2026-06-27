import { describe, it, expect } from "bun:test";
import {
  connectBridge,
  relayedMessageSchema,
  clampRectToViewport,
  isKnownAnnotationId,
  type BridgeHandlers,
  type BridgeRect,
} from "@/features/viewer/lib/bridge";

// annotation-hover-card S-003 — the PARENT-side relay for HTML-doc hover peek + click pin, and the
// C-006 untrusted-relay validation (Zod-parse, id-membership no-op, rect clamp). The in-iframe relay
// (mark-click+rect / mark-enter / mark-leave / mark-rect, coalesce by id) is tested in
// apps/backend/.../sandbox-bridge.test.ts. Here we test the parent boundary:
//   - AS-015: a relayed mark-enter routes to onMarkEnter (id + rect) → the parent's peek.
//   - AS-016: a relayed mark-click routes to onMarkClick (id + rect) → the parent's pin.
//   - AS-017 (security): the relayed message carries NO text — the card content comes only from the
//     loaded ViewerAnnotation; the relay handler is given only an id + rect, never any body/quote.
//   - AS-027 (security): Zod-parse every message; an unknown id is a no-op (membership check); a
//     malformed/oversized/NaN/negative rect is rejected, an accepted one clamped to the viewport.
//
// happy-dom has no real iframe / cross-document event.source and no layout, so the LIVE cross-iframe
// positioning is [→MANUAL]/Playwright. We drive the captured port directly with a fake MessagePort to
// exercise the PURE, deterministic boundary (parse / route / id-check / clamp).

/** A fake MessageChannel port pair so we can deliver a relayed message to the parent's port.onmessage
 *  without a real iframe. `deliver` invokes whatever onmessage handler connectBridge wired. */
function fakePortPair() {
  const port2: any = { postMessage() {}, start() {}, close() {} };
  const port1: any = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage() {},
    start() {},
    close() {},
  };
  return { port1, port2 };
}

/** Wire connectBridge with a fake window + a fake iframe, accept the handshake carrying `port1`, and
 *  return a `deliver(data)` that pushes a relayed message into the captured port. */
function connectWithPort(handlers: BridgeHandlers) {
  const { port1 } = fakePortPair();
  const iframeWindow = { tag: "iframe-window" };
  let listener: ((e: any) => void) | null = null;
  const win = {
    addEventListener: (_t: string, fn: any) => {
      listener = fn;
    },
    removeEventListener: () => {},
  } as any;
  const conn = connectBridge({ contentWindow: iframeWindow }, handlers, win);
  // Deliver the trusted ready (source === contentWindow, carries the port) so the port is captured.
  listener!({ data: { source: "anchord-bridge", type: "ready", nonce: "n1" }, source: iframeWindow, ports: [port1] });
  return {
    conn,
    deliver: (data: unknown) => port1.onmessage?.({ data }),
  };
}

const RECT: BridgeRect = { x: 20, y: 30, width: 80, height: 16 };

describe("bridge relay — HTML peek/pin (S-003)", () => {
  it("AS-015: a relayed mark-enter routes to onMarkEnter with the id + rect (parent peek)", () => {
    const seen: { id: string; rect: BridgeRect | null }[] = [];
    const { deliver } = connectWithPort({
      onSelection: () => {},
      onMarkEnter: (id, rect) => seen.push({ id, rect }),
    });
    deliver({ type: "mark-enter", annotationId: "a-1", rect: RECT });
    expect(seen).toEqual([{ id: "a-1", rect: RECT }]);
    // mark-leave routes to onMarkLeave (no rect) so the parent can cancel the dwell / hide the peek.
    const left: string[] = [];
    const { deliver: deliver2 } = connectWithPort({ onSelection: () => {}, onMarkLeave: (id) => left.push(id) });
    deliver2({ type: "mark-leave", annotationId: "a-1" });
    expect(left).toEqual(["a-1"]);
  });

  it("AS-016: a relayed mark-click routes to onMarkClick with the id + rect (parent pin)", () => {
    const seen: { id: string; rect: BridgeRect | null }[] = [];
    const { deliver } = connectWithPort({
      onSelection: () => {},
      onMarkClick: (id, rect) => seen.push({ id, rect }),
    });
    deliver({ type: "mark-click", annotationId: "a-7", rect: RECT });
    expect(seen).toEqual([{ id: "a-7", rect: RECT }]);
  });

  it("AS-021: a relayed mark-rect routes to onMarkRect for the pinned-card reposition/auto-close", () => {
    const seen: { id: string; rect: BridgeRect | null }[] = [];
    const { deliver } = connectWithPort({ onSelection: () => {}, onMarkRect: (id, rect) => seen.push({ id, rect }) });
    deliver({ type: "mark-rect", annotationId: "a-3", rect: RECT });
    deliver({ type: "mark-rect", annotationId: "a-3", rect: null }); // mark gone → null rect
    expect(seen).toEqual([
      { id: "a-3", rect: RECT },
      { id: "a-3", rect: null },
    ]);
  });

  it("AS-017 (security): the relay handler receives ONLY id + rect — no text crosses the boundary", () => {
    // A forged message that smuggles a `body`/`quote` alongside a valid mark-click: the handler is
    // still called with only (id, rect); the extra fields are dropped by the schema. The card content
    // comes from the loaded ViewerAnnotation (tested in the peek/pin component tests), never the msg.
    let captured: unknown[] | null = null;
    const { deliver } = connectWithPort({
      onSelection: () => {},
      onMarkClick: (...args) => {
        captured = args;
      },
    });
    deliver({
      type: "mark-click",
      annotationId: "a-1",
      rect: RECT,
      body: "<script>alert(1)</script>",
      quote: "<b>bold</b>",
    });
    // onMarkClick's arity is exactly (annotationId, rect) — no third "body"/"quote" argument exists,
    // so there is no path for relayed markup to reach the rendered card.
    expect(captured).toEqual(["a-1", RECT]);
  });
});

describe("bridge relay — Pinpoint block-pick on HTML docs (pinpoint S-004)", () => {
  it("AS-010: a relayed block-pick routes to onBlockPick with the blockId + rect (parent create)", () => {
    // Picking an in-iframe block relays {type:'block-pick', blockId, rect} up the trusted port; the
    // parent routes it to onBlockPick → the SAME beginBlockCompose/create path the markdown pick uses.
    const seen: { id: string; rect: BridgeRect | null }[] = [];
    const { deliver } = connectWithPort({
      onSelection: () => {},
      onBlockPick: (blockId, rect) => seen.push({ id: blockId, rect }),
    });
    deliver({ type: "block-pick", blockId: "block-h1-1", rect: RECT });
    expect(seen).toEqual([{ id: "block-h1-1", rect: RECT }]);
  });

  it("AS-010: a block-pick may carry a null/absent rect (the bridge couldn't read one) — still routes", () => {
    const seen: { id: string; rect: BridgeRect | null }[] = [];
    const { deliver } = connectWithPort({
      onSelection: () => {},
      onBlockPick: (blockId, rect) => seen.push({ id: blockId, rect }),
    });
    deliver({ type: "block-pick", blockId: "block-p-3", rect: null });
    deliver({ type: "block-pick", blockId: "block-p-4" });
    expect(seen).toEqual([
      { id: "block-p-3", rect: null },
      { id: "block-p-4", rect: null },
    ]);
  });

  it("AS-011 (C-005): block-pick is in the discriminated union and a valid one parses", () => {
    expect(
      relayedMessageSchema.safeParse({ type: "block-pick", blockId: "block-h1-1", rect: RECT }).success,
    ).toBe(true);
    // rect is optional/nullable (the bridge may not be able to read one).
    expect(relayedMessageSchema.safeParse({ type: "block-pick", blockId: "block-p-1", rect: null }).success).toBe(true);
    expect(relayedMessageSchema.safeParse({ type: "block-pick", blockId: "block-p-1" }).success).toBe(true);
  });

  it("AS-011 (C-005, security): a block-pick with a malformed rect fails parse and never routes", () => {
    // The SAME rect hardening as the hover-card relay (C-006): a NaN/Infinity/negative-size rect makes
    // the WHOLE block-pick fail Zod at the parent boundary → it never reaches onBlockPick (no create).
    expect(
      relayedMessageSchema.safeParse({ type: "block-pick", blockId: "block-p-1", rect: { x: 0, y: 0, width: 1e9, height: 1 } })
        .success,
    ).toBe(true); // 1e9 is finite/non-negative → parses at the schema level; clampRectToViewport rejects it on use.
    expect(
      relayedMessageSchema.safeParse({ type: "block-pick", blockId: "block-p-1", rect: { x: 0, y: 0, width: NaN, height: 1 } })
        .success,
    ).toBe(false);
    expect(
      relayedMessageSchema.safeParse({ type: "block-pick", blockId: "block-p-1", rect: { x: 0, y: 0, width: -5, height: 1 } })
        .success,
    ).toBe(false);
    expect(
      relayedMessageSchema.safeParse({ type: "block-pick", blockId: "block-p-1", rect: { x: Infinity, y: 0, width: 1, height: 1 } })
        .success,
    ).toBe(false);
    // A NaN-rect block-pick delivered over the port never calls the handler (the message failed parse).
    let calls = 0;
    const { deliver } = connectWithPort({ onSelection: () => {}, onBlockPick: () => (calls += 1) });
    deliver({ type: "block-pick", blockId: "block-p-1", rect: { x: 0, y: 0, width: NaN, height: 1 } });
    expect(calls).toBe(0);
  });

  it("AS-011 (C-005, security): a block-pick with an empty blockId fails parse (a pick must name a block)", () => {
    expect(relayedMessageSchema.safeParse({ type: "block-pick", blockId: "", rect: RECT }).success).toBe(false);
  });

  it("AS-011 (C-005): the parent does NOT pre-validate the blockId against the iframe DOM — a forged id still routes (the matcher orphans it)", () => {
    // The parent can't reach the opaque iframe DOM, so it CANNOT check whether the id resolves. A
    // forged id ("nope") routes verbatim to onBlockPick → create stores it → the matcher never places
    // it (orphaned). Symmetric with the existing range relay; block-pick adds no new id gate.
    const seen: string[] = [];
    const { deliver } = connectWithPort({ onSelection: () => {}, onBlockPick: (blockId) => seen.push(blockId) });
    deliver({ type: "block-pick", blockId: "nope", rect: RECT });
    expect(seen).toEqual(["nope"]);
  });
});

describe("C-006 — relayedMessageSchema (Zod-parse every relayed message, AS-027)", () => {
  it("AS-027: a forged shape (not in the protocol) fails parse and is ignored", () => {
    // A body script's `parent.postMessage({annotation:…})` shape that reaches the port: no `type` it
    // recognizes → safeParse fails → the parent never acts on it.
    expect(relayedMessageSchema.safeParse({ annotation: { id: "x" } }).success).toBe(false);
    expect(relayedMessageSchema.safeParse({ type: "navigate", url: "evil" }).success).toBe(false);
    expect(relayedMessageSchema.safeParse(null).success).toBe(false);
    // A valid mark-click parses.
    expect(relayedMessageSchema.safeParse({ type: "mark-click", annotationId: "a-1", rect: RECT }).success).toBe(true);
  });

  it("AS-027: a mark event with a NaN / negative-size rect fails parse (the rect schema rejects it)", () => {
    expect(relayedMessageSchema.safeParse({ type: "mark-click", annotationId: "a", rect: { x: 1, y: 1, width: NaN, height: 1 } }).success).toBe(false);
    expect(relayedMessageSchema.safeParse({ type: "mark-enter", annotationId: "a", rect: { x: 1, y: 1, width: -5, height: 1 } }).success).toBe(false);
    expect(relayedMessageSchema.safeParse({ type: "mark-click", annotationId: "a", rect: { x: Infinity, y: 0, width: 1, height: 1 } }).success).toBe(false);
  });

  it("AS-027: an empty annotationId fails parse (a relay must name a mark)", () => {
    expect(relayedMessageSchema.safeParse({ type: "mark-click", annotationId: "" }).success).toBe(false);
  });

  it("AS-027: a relayed mark-click whose rect is dropped by parse never calls the handler", () => {
    // A bad-rect mark-click never reaches onMarkClick (the whole message failed parse → ignored).
    let calls = 0;
    const { deliver } = connectWithPort({ onSelection: () => {}, onMarkClick: () => (calls += 1) });
    deliver({ type: "mark-click", annotationId: "a", rect: { x: 0, y: 0, width: NaN, height: 1 } });
    expect(calls).toBe(0);
  });
});

describe("C-006 — isKnownAnnotationId (id ∈ loaded set, miss = no-op, AS-027)", () => {
  it("AS-027: an id NOT in the loaded, role-filtered set is a no-op (no card)", () => {
    const loaded = new Set(["a-1", "a-2"]);
    expect(isKnownAnnotationId("a-1", loaded)).toBe(true);
    // A forged id the viewer never loaded → false → the caller opens nothing.
    expect(isKnownAnnotationId("ann-not-loaded", loaded)).toBe(false);
    // An empty / unrelated set → always a miss.
    expect(isKnownAnnotationId("a-1", new Set())).toBe(false);
  });
});

describe("C-006 — clampRectToViewport (reject bad rect, clamp accepted one, AS-027)", () => {
  const VP = { width: 1000, height: 800 };

  it("AS-027: an oversized forged rect ({width:1e9,height:1e9}) is rejected (opens nothing)", () => {
    expect(clampRectToViewport({ x: 0, y: 0, width: 1e9, height: 1e9 }, VP)).toBeNull();
  });

  it("AS-027: a NaN / negative rect is rejected", () => {
    expect(clampRectToViewport({ x: 0, y: 0, width: NaN, height: 10 }, VP)).toBeNull();
    expect(clampRectToViewport({ x: 0, y: 0, width: -10, height: 10 }, VP)).toBeNull();
    expect(clampRectToViewport({ x: Infinity, y: 0, width: 10, height: 10 }, VP)).toBeNull();
  });

  it("AS-027: a rect entirely off-screen (past the right edge) is rejected", () => {
    expect(clampRectToViewport({ x: 1200, y: 0, width: 10, height: 10 }, VP)).toBeNull();
    expect(clampRectToViewport({ x: 0, y: -50, width: 10, height: 10 }, VP)).toBeNull(); // entirely above
  });

  it("AS-027: an in-bounds rect passes through unchanged", () => {
    const r = { x: 100, y: 100, width: 80, height: 16 };
    expect(clampRectToViewport(r, VP)).toEqual(r);
  });

  it("AS-027: a partly off-screen rect is CLAMPED into the viewport (whole card stays visible)", () => {
    // x negative but with on-screen intersection → x clamped to 0, width shrunk to the remainder.
    expect(clampRectToViewport({ x: -20, y: 100, width: 80, height: 16 }, VP)).toEqual({ x: 0, y: 100, width: 60, height: 16 });
    // a rect running past the right edge → clamped so x+width never exceeds the viewport.
    expect(clampRectToViewport({ x: 960, y: 100, width: 80, height: 16 }, VP)).toEqual({ x: 960, y: 100, width: 40, height: 16 });
  });
});
