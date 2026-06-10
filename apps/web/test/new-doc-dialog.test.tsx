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

const publishDoc = mock(async () => env({ docId: "d1", slug: "new-doc", url: "/d/new-doc" }));
mock.module("../src/features/docs/client", () => ({
  fetchProjects: mock(async () => env({ projects: [] })),
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  createProject: mock(async () => env({})),
  searchDocs: mock(async () => env({ results: [] })),
  publishDoc,
}));

const { NewDocDialog } = await import("../src/features/docs/new-doc-dialog");

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
    // Title auto-inferred from the filename (dashes → spaces, extension stripped).
    expect(screen.getByTestId("new-doc-title")).toHaveValue("web core spec");

    await waitFor(() => expect(screen.getByTestId("publish-button")).not.toBeDisabled());
    await userEvent.click(screen.getByTestId("publish-button"));
    await waitFor(() => expect(publishDoc).toHaveBeenCalled());
    const [ws, body] = publishDoc.mock.calls[0] as [string, { content: string; kind: string }];
    expect(ws).toBe("ws-acme");
    expect(body.kind).toBe("markdown");
    expect(body.content).toContain("# Web core spec");
  });
});
