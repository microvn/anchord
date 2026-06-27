import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { activityRoutes } from "./activity";
import type { ActivityRepo, ActivityFilter } from "../activity/repo";
import type { Actor } from "../http/auth-gate";

// Perf regression guard (index/query audit P1b): the activity feed + stats rail must NOT load the
// whole workspace log into JS on every request. The route is wired so:
//   - the feed caps the recent-first scan  → listAllActivity(filter, { max })
//   - the stats rail bounds to the 7-day window in SQL → listAllActivity(filter, { since })
// This test injects a fake repo that records the opts each endpoint passes, so a future revert to an
// unbounded `listAllActivity(filter)` (no opts) fails here. No DB — pure route wiring assertion.

interface Call {
  filter: ActivityFilter;
  opts?: { since?: Date; max?: number };
}

function makeRecordingRepo(): { repo: ActivityRepo; calls: Call[] } {
  const calls: Call[] = [];
  const repo: ActivityRepo = {
    async insertActivity() {
      return { id: "a1" };
    },
    async countActivity() {
      return 0;
    },
    async listActivity() {
      return [];
    },
    async listAllActivity(filter, opts) {
      calls.push({ filter, opts });
      return [];
    },
    async getActivityById() {
      return null;
    },
    async listRelatedByDoc() {
      return [];
    },
  };
  return { repo, calls };
}

function appWith(repo: ActivityRepo) {
  const resolveSession = async (): Promise<Actor | null> => ({ userId: "u1" });
  const resolveWorkspaceRole = async () => "admin" as const;
  return new Elysia().use(activityRoutes({ repo, resolveSession, resolveWorkspaceRole }));
}

test("feed caps the recent-first scan (max), never an unbounded full-log load", async () => {
  const { repo, calls } = makeRecordingRepo();
  const app = appWith(repo);
  const res = await app.handle(new Request("http://localhost/api/w/ws1/activity"));
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.opts?.max).toBe(5000);
});

test("stats bounds the scan to the trailing 7-day window in SQL (since)", async () => {
  const { repo, calls } = makeRecordingRepo();
  const app = appWith(repo);
  const before = Date.now();
  const res = await app.handle(new Request("http://localhost/api/w/ws1/activity/stats"));
  const after = Date.now();
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
  const since = calls[0]!.opts?.since;
  expect(since).toBeInstanceOf(Date);
  // since ≈ now - 7 days; allow the request's wall-clock slack on both ends.
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  expect(since!.getTime()).toBeGreaterThanOrEqual(before - sevenDaysMs - 1000);
  expect(since!.getTime()).toBeLessThanOrEqual(after - sevenDaysMs + 1000);
});
