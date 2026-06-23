import { test, expect } from "bun:test";
import {
  parseDefaultAccess,
  defaultWorkspaceSettings,
  DEFAULT_WORKSPACE_ACCESS,
} from "./settings";

// shared-workspace model (workspaces:C-007): the new-doc default is anyone_in_workspace, uniform.

test("C-007: the uniform default is anyone_in_workspace", () => {
  expect(DEFAULT_WORKSPACE_ACCESS).toBe("anyone_in_workspace");
  expect(defaultWorkspaceSettings()).toEqual({ defaultAccess: "anyone_in_workspace" });
});

test("C-007: parseDefaultAccess returns an explicitly stored level", () => {
  expect(parseDefaultAccess({ defaultAccess: "restricted" })).toBe("restricted");
  expect(parseDefaultAccess({ defaultAccess: "anyone_with_link" })).toBe("anyone_with_link");
  expect(parseDefaultAccess({ defaultAccess: "anyone_in_workspace" })).toBe("anyone_in_workspace");
});

test("C-007: an absent setting reads as anyone_in_workspace (legacy {} rows need no migration)", () => {
  expect(parseDefaultAccess({})).toBe("anyone_in_workspace");
  expect(parseDefaultAccess(null)).toBe("anyone_in_workspace");
  expect(parseDefaultAccess(undefined)).toBe("anyone_in_workspace");
});

test("C-007: an unrecognized value falls back to anyone_in_workspace (never trusts junk)", () => {
  expect(parseDefaultAccess({ defaultAccess: "public" })).toBe("anyone_in_workspace");
  expect(parseDefaultAccess({ defaultAccess: 42 })).toBe("anyone_in_workspace");
  expect(parseDefaultAccess({ defaultAccess: "" })).toBe("anyone_in_workspace");
});
