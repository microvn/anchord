import { describe, expect, it } from "bun:test";
import { api } from "../src/lib/api";

// Phase 0 guard: the Eden client's type must resolve to the REAL backend `App` type, not
// `any`. If `import type { App } from "backend"` ever collapsed to `any` (e.g. a stray
// tsconfig `paths` into backend src), `api.api` would be typed `any` and the assignment
// below would still compile — so we assert on a route the static `App` type DOES surface.
//
// `App = typeof app` only statically widens to the UNCONDITIONALLY-mounted routes; /health
// is one. The conditional /api/* routes are reached at runtime via features/*/client.ts
// casts (documented there). Here we only need ONE real typed leaf to prove App != any.
//
// The `: never` extends-check makes this fail at TYPECHECK time if `health` were `any`:
// `any` is assignable to `never`, but a real function type is not, so `EnsureNotAny`
// resolves to the literal route and the assignment holds only for the real type.
type IsAny<T> = 0 extends 1 & T ? true : false;
type HealthGet = typeof api.health.get;
type HealthIsAny = IsAny<HealthGet>;

// A compile-time assertion: HealthIsAny must be `false`. If `App` degraded to `any`,
// `HealthGet` would be `any`, `HealthIsAny` would be `true`, and this line would error.
const _typeCheck: HealthIsAny extends false ? true : never = true;

describe("eden App type is real (not any)", () => {
  it("exposes a typed /health route on the treaty client", () => {
    expect(_typeCheck).toBe(true);
    expect(typeof api.health.get).toBe("function");
  });
});
