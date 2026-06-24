import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";
import type { MyActivityPage } from "@/features/your-activity/types";

// Typed request thunk for the personal "Your actions" feed (your-activity-actions S-001) —
// `GET /api/me/activity`. Same pattern + rationale as the notifications client: the backend mounts
// this route CONDITIONALLY (`if (deps.meActivity) …`), so the exported treaty type doesn't surface
// it through chaining. We reach it through the same runtime treaty client (it resolves paths
// dynamically) and annotate the return ourselves. Component/hook tests mock THIS module, so the
// cast is never exercised at runtime.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

/** GET /api/me/activity — the caller's own actions across their current workspaces, newest-first. */
export function listMyActivity(page = 1): Promise<EdenResult<MyActivityPage>> {
  return treaty.api.me.activity.get({ query: { page } }) as Promise<EdenResult<MyActivityPage>>;
}
