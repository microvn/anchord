// Test foundation: install a global DOM (happy-dom) so React + Testing Library can
// render, then register @testing-library/jest-dom matchers on bun's expect and wire
// Testing Library's auto-cleanup to bun's afterEach. Loaded via bunfig.toml `preload`.
//
// Order matters: @testing-library/dom binds its `screen` queries to `document.body` at
// MODULE-EVAL time, so the global DOM must exist BEFORE testing-library is evaluated.
// We register happy-dom first, then pull testing-library in via dynamic import so its
// module graph evaluates against the already-registered global document.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { happyDOM?: unknown }).happyDOM) {
  // Give happy-dom a concrete origin so `window.location.origin` is a real URL (not
  // "null"). The auth client + Eden client both read `window.location.origin` at module
  // eval; without a URL here better-auth throws "Invalid base URL: null/api/auth".
  GlobalRegistrator.register({ url: "http://localhost:3000" });
}

// Radix UI primitives (Select, DropdownMenu, …) call DOM APIs happy-dom doesn't implement.
// Shim the three Radix Select needs so it can open/select under bun test: pointer-capture
// probing, scrollIntoView (focus-into-view on the active option), and a no-op releasePointer.
if (typeof Element !== "undefined") {
  const el = Element.prototype as unknown as Record<string, unknown>;
  el.hasPointerCapture ??= () => false;
  el.setPointerCapture ??= () => {};
  el.releasePointerCapture ??= () => {};
  el.scrollIntoView ??= () => {};
}

import { afterEach, expect } from "bun:test";

const matchers = await import("@testing-library/jest-dom/matchers");
const { cleanup } = await import("@testing-library/react");

expect.extend(matchers as unknown as Parameters<typeof expect.extend>[0]);

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
