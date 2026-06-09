import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { authProvidersRoutes } from "./auth-providers";
import type { Config } from "../config/env";

// auth-ui GAP-002 (AS-007) — the enabled-OAuth-provider read the FE calls to know which
// "Continue with …" buttons to render. Creds present → provider listed; creds absent →
// NOT listed (so its button never renders). Top-level, pre-session, enveloped.

function app(oauth: Config["oauth"]) {
  return new Elysia().use(authProvidersRoutes({ oauth }));
}

async function getProviders(oauth: Config["oauth"]): Promise<string[]> {
  const res = await app(oauth).handle(
    new Request("http://localhost/api/auth-providers"),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: { providers: string[] } };
  expect(body.success).toBe(true);
  return body.data.providers;
}

test("AS-007: GET /api/auth-providers lists a provider whose ENV creds are present (GitHub)", async () => {
  const providers = await getProviders({ github: { clientId: "gh", clientSecret: "s" } });
  expect(providers).toContain("github");
});

test("AS-007: GET /api/auth-providers omits a provider with no ENV creds (Google absent)", async () => {
  // Google not configured → absent from the list → its button never renders on the FE.
  const providers = await getProviders({ github: { clientId: "gh", clientSecret: "s" } });
  expect(providers).not.toContain("google");
});

test("AS-007: no OAuth configured → empty provider list (only email+password form shows)", async () => {
  const providers = await getProviders({});
  expect(providers).toEqual([]);
});

test("AS-007: both providers configured → both listed in stable order", async () => {
  const providers = await getProviders({
    github: { clientId: "gh", clientSecret: "s" },
    google: { clientId: "g", clientSecret: "s" },
  });
  expect(providers).toEqual(["github", "google"]);
});

test("AS-007: the read leaks no client secret — only provider names are returned", async () => {
  const res = await app({ github: { clientId: "gh-id", clientSecret: "gh-secret" } }).handle(
    new Request("http://localhost/api/auth-providers"),
  );
  const raw = await res.text();
  expect(raw).not.toContain("gh-secret");
  expect(raw).not.toContain("gh-id");
});
