// The API-infra layer's barrel. `@/lib/api` resolves here, re-exporting the typed Eden
// client (`api`, `Api`) so existing `import { api } from "@/lib/api"` call sites keep
// working after the four infra files moved under `src/lib/api/`. The siblings
// (api-error, auth-client, use-api-query) are imported via their own `@/lib/api/<file>`
// paths — they are not re-exported here, to keep the barrel scoped to the client itself.
export { api, type Api } from "./api";
