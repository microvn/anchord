import { test, expect } from "bun:test";
import { parseConfig, ConfigError } from "./env";

// A minimal valid env with the SMTP provider configured. Other tests vary the
// email provider (SMTP / Resend / both / neither) on top of this base.
const baseNoMail = {
  APP_SECRET: "x".repeat(16),
  DATABASE_URL: "postgres://anchord:anchord@localhost:5432/anchord",
  // S-007: APP_URL is now boot-mandatory (absolute http(s)://). Every valid env carries it.
  APP_URL: "https://anchord.example.com",
};
const smtpEnv = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "anchord",
  SMTP_PASS: "secret",
};
const valid = { ...baseNoMail, ...smtpEnv };

test("AS-001: parseConfig accepts a complete valid env", () => {
  const cfg = parseConfig(valid);
  expect(cfg.APP_SECRET).toBe(valid.APP_SECRET);
  expect(cfg.DATABASE_URL).toBe(valid.DATABASE_URL);
  expect(cfg.SMTP?.host).toBe("smtp.example.com");
  expect(cfg.PORT).toBe(3000); // default
});

test("AS-003: parseConfig refuses missing APP_SECRET, names it", () => {
  const { APP_SECRET, ...rest } = valid;
  let err: unknown;
  try { parseConfig(rest); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toContain("APP_SECRET");
});

test("AS-003: parseConfig refuses APP_SECRET shorter than 16", () => {
  let err: unknown;
  try { parseConfig({ ...valid, APP_SECRET: "tooshort" }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toContain("APP_SECRET");
});

test("AS-004 / self-host AS-004: no email provider at all (neither SMTP nor RESEND_API_KEY) refuses boot", () => {
  // self-host AS-004 / C-002 + auth C-008: an email provider is mandatory. Drop every
  // SMTP_* field AND leave RESEND_API_KEY unset → the app must refuse to start with a
  // log that names the requirement (consistent across both specs).
  let err: unknown;
  try { parseConfig({ ...baseNoMail }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  const m = (err as ConfigError).message;
  expect(m).toContain("email provider");
  expect(m).toContain("SMTP_*");
  expect(m).toContain("RESEND_API_KEY");
});

test("C-008: an incomplete SMTP group with no RESEND_API_KEY refuses boot (half-configured provider is not a provider)", () => {
  // SMTP_* is only a valid provider when HOST+PORT+USER+PASS are all present.
  // A partial group (HOST only) with no Resend is "no provider" → refuse boot.
  for (const missing of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"] as const) {
    const rest: Record<string, unknown> = { ...valid };
    delete rest[missing];
    let err: unknown;
    try { parseConfig(rest); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain("email provider");
  }
});

test("C-008: SMTP-only configured → boots, email.kind === 'smtp'", () => {
  const cfg = parseConfig(valid);
  expect(cfg.email.kind).toBe("smtp");
  if (cfg.email.kind === "smtp") {
    expect(cfg.email.host).toBe("smtp.example.com");
    expect(cfg.email.port).toBe(587);
    expect(cfg.email.user).toBe("anchord");
    expect(cfg.email.pass).toBe("secret");
  }
});

test("C-008: RESEND-only configured (no SMTP) → boots, email.kind === 'resend'", () => {
  const cfg = parseConfig({ ...baseNoMail, RESEND_API_KEY: "re_test_key" });
  expect(cfg.email.kind).toBe("resend");
  if (cfg.email.kind === "resend") {
    expect(cfg.email.apiKey).toBe("re_test_key");
  }
  // No SMTP group present → the legacy SMTP block is undefined.
  expect(cfg.SMTP).toBeUndefined();
});

test("C-008: both SMTP and RESEND_API_KEY configured → Resend API wins (email.kind === 'resend')", () => {
  const cfg = parseConfig({ ...valid, RESEND_API_KEY: "re_test_key" });
  expect(cfg.email.kind).toBe("resend");
  if (cfg.email.kind === "resend") {
    expect(cfg.email.apiKey).toBe("re_test_key");
  }
  // SMTP is still parsed/retained for back-compat, but it is not the active provider.
  expect(cfg.SMTP?.host).toBe("smtp.example.com");
});

test("C-002: parseConfig refuses a non-postgres DATABASE_URL", () => {
  let err: unknown;
  try { parseConfig({ ...valid, DATABASE_URL: "mysql://x" }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toContain("DATABASE_URL");
});

test("AS-022: parseConfig accepts a valid absolute APP_URL", () => {
  const cfg = parseConfig({ ...valid, APP_URL: "https://anchord.example.com" });
  expect(cfg.APP_URL).toBe("https://anchord.example.com");
});

test("AS-022: boot fails fast when APP_URL is unset (validated at boot like DATABASE_URL)", () => {
  const { APP_URL, ...rest } = valid;
  let err: unknown;
  try { parseConfig(rest); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toContain("APP_URL");
});

test("AS-022: boot fails fast when APP_URL is not an absolute http(s):// URL ('notaurl')", () => {
  let err: unknown;
  try { parseConfig({ ...valid, APP_URL: "notaurl" }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toContain("APP_URL");
  // A relative path is likewise rejected — only an absolute http(s) base boots.
  let err2: unknown;
  try { parseConfig({ ...valid, APP_URL: "/d/spec" }); } catch (e) { err2 = e; }
  expect(err2).toBeInstanceOf(ConfigError);
});
