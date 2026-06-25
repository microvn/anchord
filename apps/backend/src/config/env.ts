import { z } from "zod";

/** Thrown when required configuration is missing/invalid. Message names each bad key. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Required config validated at boot (self-host C-002). An EMAIL PROVIDER is mandatory
// (auth C-008): the app must not start unless EITHER a complete SMTP group OR
// RESEND_API_KEY is configured — so email verification always works, no degrade path.
// Both present → Resend HTTP API wins (resolved in `emailFrom`).
const EMAIL_PROVIDER_REQUIRED =
  "an email provider is required: set SMTP_* (HOST+PORT+USER+PASS) or RESEND_API_KEY";

// Optional env strings arrive as "" when an operator leaves a key blank or docker compose
// forwards an unset `${VAR:-}`. Treat empty/whitespace as "not set" (undefined) so a blank
// optional credential disables its feature instead of failing boot with a min-length error
// (a half-configured OAuth provider stays off; it never blocks the app — auth C-004).
const optionalEnvString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    // APP_SECRET signs sessions/share-link tokens — must be hard to guess.
    APP_SECRET: z.string().min(16, "APP_SECRET must be at least 16 characters"),
    DATABASE_URL: z
      .string()
      .refine((s) => /^postgres(ql)?:\/\//.test(s), "DATABASE_URL must be a postgres:// URL"),
    // APP_URL — the absolute public base URL of this instance (notifications-email S-007, C-013).
    // Validated at boot like DATABASE_URL: the app refuses to start without a valid absolute
    // http(s):// URL, because notification emails build absolute deep-links from it
    // (`{APP_URL}/d/{slug}#annotation-{id}`) and the invite accept-links are relative-and-broken
    // without it. A relative or non-http value (e.g. "notaurl") is a config error → no boot.
    APP_URL: z
      .string()
      .refine(
        (s) => /^https?:\/\/.+/.test(s),
        "APP_URL must be an absolute http(s):// URL",
      ),
    // SMTP — now OPTIONAL per field. A provider is "SMTP" only when the WHOLE group
    // (HOST+PORT+USER+PASS) is present; the cross-field rule below enforces that.
    SMTP_HOST: optionalEnvString,
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: optionalEnvString,
    SMTP_PASS: optionalEnvString,
    // Resend HTTP API key — the alternative email provider (auth C-008). Both present
    // → Resend wins.
    RESEND_API_KEY: optionalEnvString,
    // Images live on a volume (C-003); content text lives in Postgres.
    ASSETS_DIR: z.string().default("/data/assets"),
    CORS_ORIGIN: z.string().default("*"),
    // self-host S-005 / C-007: absolute path to the built web app (apps/web `dist`). Set by the
    // production image (Dockerfile ENV) so the instance serves the SPA + assets + deep-link
    // fallback. Unset in dev → the Vite dev server owns the FE, the backend stays API-only.
    WEB_ROOT: optionalEnvString,
  // OAuth providers (auth S-002) are OPTIONAL per self-host: an operator who does not
  // configure a provider simply does not get that sign-in button (C-004 / S-004 owns
  // the "disabled provider not shown" UI). A provider is ENABLED only when BOTH its id
  // and secret are present — a half-configured provider stays off, never half-on.
    GITHUB_CLIENT_ID: optionalEnvString,
    GITHUB_CLIENT_SECRET: optionalEnvString,
    GOOGLE_CLIENT_ID: optionalEnvString,
    GOOGLE_CLIENT_SECRET: optionalEnvString,
  })
  // C-008 / self-host AS-004 + C-002: an email provider is mandatory. Valid only when
  // EITHER the full SMTP group is present OR RESEND_API_KEY is set. Neither → refuse boot.
  .superRefine((d, ctx) => {
    const smtpComplete = Boolean(d.SMTP_HOST && d.SMTP_USER && d.SMTP_PASS);
    const hasResend = Boolean(d.RESEND_API_KEY);
    if (!smtpComplete && !hasResend) {
      ctx.addIssue({ code: "custom", message: EMAIL_PROVIDER_REQUIRED, path: ["email"] });
    }
  });

/**
 * The resolved, active email provider (auth C-008). Exactly one transport runs:
 * Resend HTTP API when RESEND_API_KEY is set (wins over SMTP), else SMTP.
 */
export type EmailProvider =
  | { kind: "resend"; apiKey: string }
  | { kind: "smtp"; host: string; port: number; user: string; pass: string };

export type Config = {
  NODE_ENV: "development" | "production" | "test";
  PORT: number;
  APP_SECRET: string;
  DATABASE_URL: string;
  /**
   * The absolute public base URL of this instance (S-007). Used to build absolute deep-links
   * in notification email (`{APP_URL}/d/{slug}#annotation-{id}`) and invite accept-links.
   * No trailing slash is assumed by consumers; they join with a leading-slash path.
   */
  APP_URL: string;
  /**
   * The active email provider, resolved from the SMTP group or RESEND_API_KEY (both → resend).
   * This is what the mail transport selector reads (auth AS-012).
   */
  email: EmailProvider;
  /**
   * Legacy raw SMTP block, present only when the SMTP group was supplied — kept for
   * back-compat. Prefer `email`. Undefined when only Resend is configured.
   */
  SMTP?: { host: string; port: number; user: string; pass: string };
  ASSETS_DIR: string;
  CORS_ORIGIN: string;
  /** Absolute path to the built web app served by the instance (S-005); undefined in dev. */
  WEB_ROOT?: string;
  // Present only when both id+secret were supplied; otherwise undefined (provider off).
  oauth: {
    github?: { clientId: string; clientSecret: string };
    google?: { clientId: string; clientSecret: string };
  };
};

/** Build the oauth config block: a provider is included ONLY when BOTH id+secret are set. */
function oauthFrom(d: {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}): Config["oauth"] {
  const oauth: Config["oauth"] = {};
  if (d.GITHUB_CLIENT_ID && d.GITHUB_CLIENT_SECRET) {
    oauth.github = { clientId: d.GITHUB_CLIENT_ID, clientSecret: d.GITHUB_CLIENT_SECRET };
  }
  if (d.GOOGLE_CLIENT_ID && d.GOOGLE_CLIENT_SECRET) {
    oauth.google = { clientId: d.GOOGLE_CLIENT_ID, clientSecret: d.GOOGLE_CLIENT_SECRET };
  }
  return oauth;
}

/** Parse + validate a raw env object. Throws ConfigError (message names every bad key) on failure. */
export function parseConfig(raw: Record<string, unknown>): Config {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => {
      const key = i.path.join(".") || "(root)";
      return `  - ${key}: ${i.message}`;
    });
    throw new ConfigError(
      "Invalid configuration — app cannot start:\n" + lines.join("\n"),
    );
  }
  const d = r.data;
  const smtpComplete = Boolean(d.SMTP_HOST && d.SMTP_USER && d.SMTP_PASS);
  // Legacy SMTP block: only when the full group was supplied.
  const smtp = smtpComplete
    ? { host: d.SMTP_HOST!, port: d.SMTP_PORT, user: d.SMTP_USER!, pass: d.SMTP_PASS! }
    : undefined;
  // Resolve the ACTIVE provider: Resend wins when its key is present (C-008).
  const email: EmailProvider = d.RESEND_API_KEY
    ? { kind: "resend", apiKey: d.RESEND_API_KEY }
    : { kind: "smtp", host: d.SMTP_HOST!, port: d.SMTP_PORT, user: d.SMTP_USER!, pass: d.SMTP_PASS! };
  return {
    NODE_ENV: d.NODE_ENV,
    PORT: d.PORT,
    APP_SECRET: d.APP_SECRET,
    DATABASE_URL: d.DATABASE_URL,
    APP_URL: d.APP_URL,
    email,
    SMTP: smtp,
    ASSETS_DIR: d.ASSETS_DIR,
    CORS_ORIGIN: d.CORS_ORIGIN,
    WEB_ROOT: d.WEB_ROOT,
    oauth: oauthFrom(d),
  };
}

/** Boot-time loader: parse process.env, log clearly and exit(1) if invalid (self-host S-002). */
export function loadConfig(): Config {
  try {
    return parseConfig(process.env as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
