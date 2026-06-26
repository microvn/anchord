import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// render-publish S-001 — the New-doc dialog (NewDocDialog). Client MOCKED. Asserts: pasting
// content enables Publish and posts to the publish endpoint (AS-001); an empty/over-cap input
// is rejected inline before any request (AS-004/AS-014). sonner is mocked to avoid a real toast
// host. Pixel/responsive [→MANUAL]; real round-trip [→E2E].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }),
}));

// The project picker (S-003) reads the workspace's projects through useProjects → fetchProjects.
// Tests swap this list per-case to cover the default-preselect (AS-009), a chosen non-default
// project (AS-008), and the workspace-scoped-only listing (C-003). Default empty → the original
// S-001 tests still see no projects, so projectId stays undefined for them.
let projectsList: { id: string; name: string; isDefault: boolean; archived: boolean }[] = [];

const publishDoc = mock(async () => env({ docId: "d1", slug: "new-doc", url: "/d/new-doc" }));
const fetchProjects = mock(async () => env({ projects: projectsList }));
mock.module("@/features/docs/services/client", () => ({
  fetchProjects,
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  fetchWorkspaceDocs: mock(async () => env({ docs: [], projects: [] })),
  createProject: mock(async () => env({})),
  // The project-mutation thunks are included so this process-global mock.module does not
  // UNDER-shadow the real client for sibling test files (bun mock.module is process-wide — an
  // incomplete mock here erases `renameProject`/etc. for project-manage.test).
  renameProject: mock(async () => env({})),
  setProjectVisibility: mock(async () => env({})),
  archiveProject: mock(async () => env({})),
  unarchiveProject: mock(async () => env({})),
  deleteProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc,
  moveDoc: mock(async () => env({})),
  copyDoc: mock(async () => env({})),
  deleteDoc: mock(async () => env({ docId: "d1", slug: "spec", deleted: true })),
}));

const { NewDocDialog } = await import("@/features/docs/components/new-doc-dialog");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Host() {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-acme/docs"]}>
        <NewDocDialog open onOpenChange={() => {}} workspaceId="ws-acme" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  publishDoc.mockClear();
  fetchProjects.mockClear();
  projectsList = [];
});

// A workspace with two projects: the default ("Default") and a non-default ("Billing").
const TWO_PROJECTS = [
  { id: "p-default", name: "Default", isDefault: true, archived: false },
  { id: "p-billing", name: "Billing", isDefault: false, archived: false },
];

// Helper: switch to Paste and type publishable content (the cheapest path to an enabled Publish).
async function pasteSomething() {
  await userEvent.click(screen.getByTestId("tab-paste"));
  await userEvent.type(screen.getByTestId("paste-area"), "# Hello\n\nbody");
  await waitFor(() => expect(screen.getByTestId("publish-button")).not.toBeDisabled());
}

describe("workspace-project-ui S-003 — publish into a chosen project", () => {
  it("AS-009: the default project is pre-selected in the picker", async () => {
    projectsList = TWO_PROJECTS;
    render(<Host />);
    // The picker defaults to the workspace's default project (Default), shown on the trigger.
    await waitFor(() => expect(screen.getByTestId("new-doc-project")).toHaveTextContent("Default"));

    await pasteSomething();
    // Publish WITHOUT touching the picker → the doc lands in the default project.
    await userEvent.click(screen.getByTestId("publish-button"));
    await waitFor(() => expect(publishDoc).toHaveBeenCalled());
    const [, body] = publishDoc.mock.calls[0] as [string, { projectId?: string }];
    expect(body.projectId).toBe("p-default");
  });

  it("AS-008: selecting a non-default project publishes the doc into it", async () => {
    projectsList = TWO_PROJECTS;
    render(<Host />);
    await waitFor(() => expect(screen.getByTestId("new-doc-project")).toHaveTextContent("Default"));

    // Open the Radix Select and pick "Billing".
    await userEvent.click(screen.getByTestId("new-doc-project"));
    await userEvent.click(await screen.findByRole("option", { name: "Billing" }));
    await waitFor(() => expect(screen.getByTestId("new-doc-project")).toHaveTextContent("Billing"));

    await pasteSomething();
    await userEvent.click(screen.getByTestId("publish-button"));
    await waitFor(() => expect(publishDoc).toHaveBeenCalled());
    const [, body] = publishDoc.mock.calls[0] as [string, { projectId?: string }];
    expect(body.projectId).toBe("p-billing");
  });

  it("C-003: the picker lists exactly the active workspace's projects", async () => {
    projectsList = TWO_PROJECTS;
    render(<Host />);
    await waitFor(() => expect(screen.getByTestId("new-doc-project")).toHaveTextContent("Default"));

    // Open the picker → it offers Default + Billing and nothing else (the list is workspace-scoped).
    await userEvent.click(screen.getByTestId("new-doc-project"));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Default (Default)", "Billing"]);
  });

  it("perf: a CLOSED dialog does NOT fetch the picker's project list (gated on `open`)", async () => {
    // The dialog is mounted (closed) in the sidebar on every workspace page — its useProjects must
    // stay idle until opened, else every page pays a redundant projects read. Regression guard for
    // the `/w/:id/projects` two-`projects`-requests storm (the picker fetched on every page).
    projectsList = TWO_PROJECTS;
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={["/w/ws-acme/docs"]}>
          <NewDocDialog open={false} onOpenChange={() => {}} workspaceId="ws-acme" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Let any (disabled) query settle; an enabled query would have called fetchProjects by now.
    await waitFor(() => expect(fetchProjects).not.toHaveBeenCalled());
    expect(fetchProjects).toHaveBeenCalledTimes(0);
  });
});

describe("render-publish S-001 — New-doc dialog", () => {
  it("AS-001: pasting content enables Publish and posts to the publish endpoint", async () => {
    render(<Host />);
    // The Publish button is disabled with no content.
    expect(screen.getByTestId("publish-button")).toBeDisabled();

    // Switch to the Paste tab and type content → Publish enables.
    await userEvent.click(screen.getByTestId("tab-paste"));
    await userEvent.type(screen.getByTestId("paste-area"), "# Hello\n\nbody");
    await waitFor(() => expect(screen.getByTestId("publish-button")).not.toBeDisabled());

    await userEvent.click(screen.getByTestId("publish-button"));
    await waitFor(() => expect(publishDoc).toHaveBeenCalled());
    const [ws, body] = publishDoc.mock.calls[0] as [string, { content: string; kind: string }];
    expect(ws).toBe("ws-acme");
    expect(body.content).toContain("# Hello");
    expect(body.kind).toBe("markdown");
  });

  it("AS-014: an empty paste keeps Publish disabled (no request)", async () => {
    render(<Host />);
    await userEvent.click(screen.getByTestId("tab-paste"));
    await userEvent.type(screen.getByTestId("paste-area"), "   ");
    // Whitespace-only is not publishable; the button stays disabled and nothing is sent.
    expect(screen.getByTestId("publish-button")).toBeDisabled();
    expect(publishDoc).not.toHaveBeenCalled();
  });

  it("AS-001: an uploaded file infers the title and publishes with the file's content + kind", async () => {
    render(<Host />);
    // Upload a supported .md file → the picked-file chip appears, the title is auto-inferred.
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    const md = new File(["# Web core spec\nbody"], "web-core-spec.md", { type: "text/markdown" });
    await userEvent.upload(input, md);

    await waitFor(() => expect(screen.getByTestId("picked-file")).toHaveTextContent("web-core-spec.md"));
    // Title auto-inferred from the filename (dashes → spaces, extension stripped, first char capitalized).
    expect(screen.getByTestId("new-doc-title")).toHaveValue("Web core spec");

    await waitFor(() => expect(screen.getByTestId("publish-button")).not.toBeDisabled());
    await userEvent.click(screen.getByTestId("publish-button"));
    await waitFor(() => expect(publishDoc).toHaveBeenCalled());
    const [ws, body] = publishDoc.mock.calls[0] as [string, { content: string; kind: string }];
    expect(ws).toBe("ws-acme");
    expect(body.kind).toBe("markdown");
    expect(body.content).toContain("# Web core spec");
  });
});
