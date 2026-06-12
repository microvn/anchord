// better-auth instance/factory (auth S-001).
//
// Why a factory: createAuth(db, opts) lets tests build the instance against an
// injected DB (the project's "injectable ports" pattern, cf. publish/service.ts)
// and lets src/index.ts wire the real Postgres DB at boot.
//
// Locked decisions (CLAUDE.md + spec auth.md):
//  - email+password ENABLED, requireEmailVerification, minPasswordLength=8 (C-006).
//  - DB-backed sessions, NOT JWT — revocable for logout/session-ban (C-001). We do
//    NOT add the JWT plugin and do NOT disable DB session storage, so better-auth's
//    default DB-session strategy stands; `auth.api.revokeSession` is the revoke path.
//  - sign-in rate limiting ENABLED against brute force (C-007).
//  - APP_SECRET signs the session cookie (httpOnly by better-auth default).
//
// The user/session/account/verification tables live in src/db/schema.ts; the
// drizzle adapter maps to them. The live sign-up/sign-in/cookie flow needs a real
// DB + HTTP and is integration-verified-later ([→E2E]); the UNIT contract here is
// the config object the app actually runs with.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { DB } from "../db/client";
import { newId } from "../db/id";
import * as schema from "../db/schema";
import { MIN_PASSWORD_LENGTH } from "./password";
import { activatePendingInvites, type PendingInviteRepo } from "./invite";
import { makeSendVerificationEmail } from "./mail-transport";
import type { MailQueue, MailTransport } from "./mail-queue";
import { oauthEmailVerified, type OAuthProvider } from "./oauth";
import { createOwnWorkspaceOnSignup, type TenancyRepo } from "../workspace/tenancy";
import { createTenancyRepo } from "../workspace/tenancy-repo";
import { createProjectRepo } from "../workspace/repo";
import type { ProjectRepo } from "../workspace/projects";

// auth S-005 (AS-008/C-005): after a user's email is verified, activate any pending
// invite issued to that exact email so they get the invited role. This is the thin
// glue that the post-verify hook calls; the activation algorithm is unit-tested in
// invite.ts against a fake repo. Wiring this into better-auth's verification
// callback (and supplying the concrete PendingInviteRepo from sharing-permissions)
// is integration-verified-later — better-auth fires the hook, this fn does the work.
export async function onEmailVerified(
  email: string,
  userId: string,
  repo: PendingInviteRepo,
) {
  // isVerified is true here by definition: this runs only after better-auth confirms
  // the verification. The activation fn still gates on it (C-005) as defense in depth.
  return activatePendingInvites(email, userId, true, repo);
}

// GAP-002 (deferred): sign-in rate-limit threshold/window were left to build time.
// Sane default: 5 attempts per 15 minutes. Named so it is one place to tune and so
// the C-007 test can assert against it rather than a magic number.
export const SIGNIN_RATE_LIMIT_MAX = 5;
export const SIGNIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 900s

// workspaces S-001 (AS-001/AS-002/C-001): when a user is created via better-auth, create
// their OWN workspace named "default" (creator = admin) + a default project. It NEVER
// joins an existing workspace — each account is isolated and reaches others only by
// invite. This is the thin glue the `databaseHooks.user.create.after` hook calls; the
// logic (create-own-workspace, admin role, default project, idempotent) is unit-tested in
// workspace/tenancy.test.ts against a fake repo. Wiring it into better-auth's create
// callback is integration-verified in test/integration/workspaces-*.itest.ts.
export async function onUserCreated(
  userId: string,
  repo: TenancyRepo,
  projectRepo?: ProjectRepo,
) {
  return createOwnWorkspaceOnSignup(userId, { repo, projectRepo });
}

/** Per-provider OAuth credentials (auth S-002). Present only when the operator set both. */
export type OAuthProviderCreds = { clientId: string; clientSecret: string };

export type CreateAuthOptions = {
  /** Signs the session cookie + tokens — APP_SECRET from env (≥16 chars). */
  secret: string;
  /** Public base URL of the app; better-auth needs it for callbacks/cookies. */
  baseURL?: string;
  /**
   * OAuth providers (auth S-002). A provider is configured ONLY when its creds are
   * present here; a missing provider is simply not added (not disabled-but-present).
   * S-004 owns the operator-facing toggle + "disabled provider rejects callback"; this
   * story only does the conditional config.
   */
  oauth?: {
    github?: OAuthProviderCreds;
    google?: OAuthProviderCreds;
  };
  /**
   * Origins better-auth trusts for sign-in/out (CSRF origin check). Production is
   * same-origin (the backend serves the built app), so the baseURL origin suffices;
   * a dev frontend served from a different origin (Vite proxy) must be listed here or
   * better-auth refuses the request as "Invalid origin". Omit → better-auth defaults to
   * the baseURL origin only.
   */
  trustedOrigins?: string[];
  /**
   * Email-verification wiring (auth S-001/S-005 — AS-001/AS-008/AS-012). When present,
   * createAuth adds better-auth's `emailVerification` block so:
   *  - sign-up sends a verification email (`sendOnSignUp`) via the shared mail queue +
   *    selected transport — without this, requireEmailVerification:true permanently
   *    blocks sign-in because no verify mail is ever sent.
   *  - on verification, any pending workspace/doc invite issued to that exact email is
   *    activated (afterEmailVerification → onEmailVerified → activatePendingInvites).
   *
   * Optional so the pure unit test (and any caller that does not need live mail) builds
   * the instance without an emailVerification block. Production (index.ts) always wires it.
   */
  emailVerification?: {
    /** Shared mail queue (retry/dead-letter) — verify mail flows through it. */
    queue: MailQueue;
    /** Selected transport (Resend/SMTP) resolved from the configured provider. */
    transport: MailTransport;
    /** Concrete pending-invite repo (sharing-permissions doc_members glue). */
    pendingInviteRepo: PendingInviteRepo;
  };
  /**
   * Sign-in rate limiting (C-007). Defaults to ENABLED — production never sets this. It
   * exists only so the integration suite, which drives many sign-up/sign-in calls in a
   * single 15-minute window against one in-process instance, can turn the brute-force
   * limiter off (it would otherwise 429 the test's own legitimate calls). Prod keeps the
   * limiter on; this is a test seam, not a relitigation of C-007.
   */
  rateLimitEnabled?: boolean;
};

/**
 * C-002 — map an OAuth provider profile to better-auth's account fields, capturing the
 * verified flag STRICTLY (via oauthEmailVerified). better-auth's `mapProfileToUser`
 * hook calls this so a matched/created account is `emailVerified: true` ONLY when the
 * provider explicitly asserted it. This is the CAPTURE; S-003 owns the auto-link DECISION.
 */
export function mapOAuthProfile(provider: OAuthProvider, profile: unknown) {
  return { emailVerified: oauthEmailVerified(provider, profile as never) };
}

/** Build the better-auth `socialProviders` block, including ONLY providers with creds. */
function socialProvidersFrom(oauth: CreateAuthOptions["oauth"]) {
  const social: Record<string, unknown> = {};
  if (oauth?.github) {
    social.github = {
      clientId: oauth.github.clientId,
      clientSecret: oauth.github.clientSecret,
      // C-002: capture GitHub's primary-email verified flag, never assume verified.
      mapProfileToUser: (profile: unknown) => mapOAuthProfile("github", profile),
    };
  }
  if (oauth?.google) {
    social.google = {
      clientId: oauth.google.clientId,
      clientSecret: oauth.google.clientSecret,
      // C-002: trust Google's email_verified claim only when strictly boolean true.
      mapProfileToUser: (profile: unknown) => mapOAuthProfile("google", profile),
    };
  }
  return social;
}

/**
 * Build the better-auth instance bound to the given Drizzle DB.
 *
 * Returns the full better-auth instance: `.handler` (mount on Elysia at
 * /api/auth/*), `.api` (server-side calls incl. revokeSession for logout — C-001),
 * and `.options` (the config contract the unit tests assert).
 */
export function createAuth(db: DB, opts: CreateAuthOptions) {
  const tenancyRepo = createTenancyRepo(db);
  const projectRepo = createProjectRepo(db);

  // AS-001/AS-012 + AS-008: when mail deps are supplied, build the emailVerification
  // block. sendVerificationEmail enqueues the verify mail through the shared queue +
  // transport (makeSendVerificationEmail), sendOnSignUp fires it on sign-up (so a
  // requireEmailVerification:true account can actually verify), and
  // afterEmailVerification activates any pending invite for the now-verified email.
  // better-auth v1.6.x callback shapes (verified against dist):
  //   sendVerificationEmail({ user, url, token }, request)
  //   afterEmailVerification(user, request)
  const ev = opts.emailVerification;
  const emailVerification = ev
    ? {
        sendOnSignUp: true,
        sendVerificationEmail: makeSendVerificationEmail(ev.queue, ev.transport),
        afterEmailVerification: async (verifiedUser: { id: string; email: string }) => {
          // AS-008: the invite-on-verify glue. onEmailVerified runs activatePendingInvites
          // with isVerified=true (better-auth has just confirmed it) so the invited role
          // is granted on the matching doc. A non-matching email finds no invites (AS-009).
          await onEmailVerified(verifiedUser.email, verifiedUser.id, ev.pendingInviteRepo);
        },
      }
    : undefined;

  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    // ID strategy (C-007 + project-wide): better-auth's user/session/account/verification
    // ids come from the SAME snowflake generator as every domain table (src/db/id.ts), so
    // the whole system uses time-ordered string ids — no uuid anywhere.
    advanced: { database: { generateId: () => newId() } },
    ...(opts.trustedOrigins ? { trustedOrigins: opts.trustedOrigins } : {}),
    ...(emailVerification ? { emailVerification } : {}),
    database: drizzleAdapter(db, { provider: "pg", schema }),
    // workspace-project S-001 (AS-002/C-001): after better-auth creates a user, add
    // them to the single workspace as `member` (no-op until first-run created the
    // workspace; the installer who ran setup is the only admin). onUserCreated holds
    // the logic; this is the wiring point (mirrors the post-verify invite hook pattern).
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser: { id: string }) => {
            await onUserCreated(createdUser.id, tenancyRepo, projectRepo);
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      // C-008 makes SMTP mandatory at boot, so email verification always works.
      requireEmailVerification: true,
      // C-006: minimum 8 chars; better-auth hashes the password.
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    // C-007: rate-limit sign-in against brute force. Default window/threshold per GAP-002.
    // `enabled` defaults true (prod); only the integration test seam turns it off.
    rateLimit: {
      enabled: opts.rateLimitEnabled ?? true,
      window: SIGNIN_RATE_LIMIT_WINDOW_SECONDS,
      max: SIGNIN_RATE_LIMIT_MAX,
    },
    // S-002: OAuth providers, each present ONLY when its creds were supplied (gated on
    // env). A missing provider is absent from socialProviders, so better-auth never
    // exposes its callback — the self-host "configure to enable" path (C-004 owned by S-004).
    socialProviders: socialProvidersFrom(opts.oauth),
    // S-003 (C-003/AS-010): account-linking safety. Default-deny so better-auth never
    // silently merges an UNTRUSTED email — no trustedProviders (nothing auto-links on the
    // strength of the provider alone) and allowDifferentEmails:false (a different email can
    // never link). The unit-tested security contract is decideAccountLink() in link.ts; the
    // actual merge wiring here (and the require_confirmation "prove ownership" flow) is
    // integration-verified-later ([→E2E]).
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        allowDifferentEmails: false,
      },
    },
    // workspaces S-003 (C-005): the login-default landing workspace. Maps the
    // session.activeWorkspaceId column so better-auth carries it on the session. NOT the
    // request scope — that is the /api/w/:workspaceId path.
    session: {
      additionalFields: {
        activeWorkspaceId: { type: "string", required: false, input: false },
      },
    },
    // No JWT plugin + DB storage left on => sessions are DB-backed and revocable (C-001).
  });
}

export type Auth = ReturnType<typeof createAuth>;
