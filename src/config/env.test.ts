import { test, expect } from "bun:test";
import { parseConfig, ConfigError } from "./env";

const valid = {
  APP_SECRET: "x".repeat(16),
  DATABASE_URL: "postgres://anchord:anchord@localhost:5432/anchord",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "anchord",
  SMTP_PASS: "secret",
};

test("AS-001: parseConfig accepts a complete valid env", () => {
  const cfg = parseConfig(valid);
  expect(cfg.APP_SECRET).toBe(valid.APP_SECRET);
  expect(cfg.DATABASE_URL).toBe(valid.DATABASE_URL);
  expect(cfg.SMTP.host).toBe("smtp.example.com");
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

test("AS-004: parseConfig refuses missing SMTP, names it", () => {
  const { SMTP_HOST, ...rest } = valid;
  let err: unknown;
  try { parseConfig(rest); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toContain("SMTP");
});

test("C-008: SMTP mandatory at boot — config load fails when SMTP_HOST is absent", () => {
  // Auth C-008: the app must not start without SMTP (so email verification always
  // works, no no-verify degrade mode). Boot config load is the enforcement point.
  const { SMTP_HOST, ...rest } = valid;
  let err: unknown;
  try { parseConfig(rest); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toContain("SMTP_HOST");
});

test("C-008: SMTP mandatory at boot — missing SMTP_USER/SMTP_PASS also refuses boot", () => {
  for (const missing of ["SMTP_USER", "SMTP_PASS"] as const) {
    const rest = { ...valid };
    delete (rest as Record<string, unknown>)[missing];
    let err: unknown;
    try { parseConfig(rest); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(missing);
  }
});

test("C-002: parseConfig refuses a non-postgres DATABASE_URL", () => {
  let err: unknown;
  try { parseConfig({ ...valid, DATABASE_URL: "mysql://x" }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).message).toContain("DATABASE_URL");
});
