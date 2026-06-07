import { z } from "zod";

/** Thrown when required configuration is missing/invalid. Message names each bad key. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Required config validated at boot (self-host C-002). SMTP is mandatory (auth C-008):
// the app must not start without it, so there is no "no-SMTP" degrade path.
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  // APP_SECRET signs sessions/share-link tokens — must be hard to guess.
  APP_SECRET: z.string().min(16, "APP_SECRET must be at least 16 characters"),
  DATABASE_URL: z
    .string()
    .refine((s) => /^postgres(ql)?:\/\//.test(s), "DATABASE_URL must be a postgres:// URL"),
  // SMTP — mandatory; missing any of these refuses boot.
  SMTP_HOST: z.string().min(1, "SMTP_HOST is required (SMTP is mandatory)"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().min(1, "SMTP_USER is required (SMTP is mandatory)"),
  SMTP_PASS: z.string().min(1, "SMTP_PASS is required (SMTP is mandatory)"),
  // Images live on a volume (C-003); content text lives in Postgres.
  ASSETS_DIR: z.string().default("/data/assets"),
  CORS_ORIGIN: z.string().default("*"),
  // OAuth providers (auth S-002) are OPTIONAL per self-host: an operator who does not
  // configure a provider simply does not get that sign-in button (C-004 / S-004 owns
  // the "disabled provider not shown" UI). A provider is ENABLED only when BOTH its id
  // and secret are present — a half-configured provider stays off, never half-on.
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

export type Config = {
  NODE_ENV: "development" | "production" | "test";
  PORT: number;
  APP_SECRET: string;
  DATABASE_URL: string;
  SMTP: { host: string; port: number; user: string; pass: string };
  ASSETS_DIR: string;
  CORS_ORIGIN: string;
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
  return {
    NODE_ENV: d.NODE_ENV,
    PORT: d.PORT,
    APP_SECRET: d.APP_SECRET,
    DATABASE_URL: d.DATABASE_URL,
    SMTP: { host: d.SMTP_HOST, port: d.SMTP_PORT, user: d.SMTP_USER, pass: d.SMTP_PASS },
    ASSETS_DIR: d.ASSETS_DIR,
    CORS_ORIGIN: d.CORS_ORIGIN,
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
