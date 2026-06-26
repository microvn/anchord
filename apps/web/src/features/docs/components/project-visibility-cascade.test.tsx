import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// project-visibility-cascade S-001 / AS-003 + AS-004 (FE guard). The make-private dialog offers TWO
// options and the cascade option discloses irreversibility (AS-003); the keep-shared choice sends NO
// cascade flag and a private→public toggle never offers the cascade option (AS-004 guard). Client +
// sonner MOCKED (no live backend; happy-dom). Pixel/responsive [→MANUAL].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

const toast = Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) });
mock.module("sonner", () => ({ toast }));

const setProjectVisibility = mock(async () => env({ id: "p1", visibility: "private" }));
mock.module("@/features/docs/services/client", () => ({ setProjectVisibility }));

const { ProjectVisibilityToggle } = await import(
  "@/features/docs/components/project-visibility-toggle"
);

type Vis = "public" | "private";

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function Harness({ visibility }: { visibility: Vis }) {
  const project = {
    id: "p1",
    name: "P",
    visibility,
    canToggleVisibility: true,
  } as any;
  return (
    <QueryClientProvider client={client()}>
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <ProjectVisibilityToggle project={project} workspaceId="ws-1" />
        </DropdownMenuContent>
      </DropdownMenu>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  setProjectVisibility.mockClear();
  toast.error.mockClear();
});

describe("project-visibility-cascade S-001 (make-private dialog)", () => {
  it("AS-003: make-private offers two options and the cascade option warns it can't be undone", async () => {
    const user = userEvent.setup();
    render(<Harness visibility="public" />);

    // Open the make-private dialog from the ⋯-menu item.
    await user.click(await screen.findByTestId("proj-more-visibility-p1"));

    // Both options render.
    const cascade = await screen.findByTestId("proj-visibility-cascade-p1");
    const keep = await screen.findByTestId("proj-visibility-keep-p1");
    expect(cascade).toBeInTheDocument();
    expect(keep).toBeInTheDocument();
    expect(cascade).toHaveTextContent(/make the project and all its docs private/i);
    expect(keep).toHaveTextContent(/keep docs shared/i);

    // The cascade option carries an irreversibility warning.
    const warning = screen.getByTestId("proj-visibility-cascade-warning-p1");
    expect(warning).toHaveTextContent(/can.?t be undone/i);
    expect(warning).toHaveTextContent(/won.?t restore/i);
  });

  it("AS-003: choosing the cascade option sends cascade:true", async () => {
    const user = userEvent.setup();
    render(<Harness visibility="public" />);
    await user.click(await screen.findByTestId("proj-more-visibility-p1"));
    await user.click(await screen.findByTestId("proj-visibility-cascade-p1"));

    await waitFor(() => expect(setProjectVisibility).toHaveBeenCalled());
    // C-001: the cascade choice threads cascade:true to the server.
    expect(setProjectVisibility).toHaveBeenCalledWith("ws-1", "p1", "private", true);
  });

  it("AS-004 (guard): the keep-shared choice sends NO cascade (docs untouched)", async () => {
    const user = userEvent.setup();
    render(<Harness visibility="public" />);
    await user.click(await screen.findByTestId("proj-more-visibility-p1"));
    await user.click(await screen.findByTestId("proj-visibility-keep-p1"));

    await waitFor(() => expect(setProjectVisibility).toHaveBeenCalled());
    // The keep-shared choice never asks the server to cascade — cascade is false/undefined.
    const call = setProjectVisibility.mock.calls[0] as unknown[];
    expect(call[0]).toBe("ws-1");
    expect(call[1]).toBe("p1");
    expect(call[2]).toBe("private");
    expect(call[3]).toBeFalsy();
  });

  it("AS-004 (guard): private→public shows no cascade option and never cascades", async () => {
    const user = userEvent.setup();
    render(<Harness visibility="private" />);
    await user.click(await screen.findByTestId("proj-more-visibility-p1"));

    // The single plain confirm — NO two-option cascade UI.
    expect(screen.queryByTestId("proj-visibility-cascade-p1")).toBeNull();
    expect(screen.queryByTestId("proj-visibility-keep-p1")).toBeNull();

    // Confirming sends no cascade flag (the parent behaviour).
    await user.click(await screen.findByTestId("proj-visibility-confirm-p1"));
    await waitFor(() => expect(setProjectVisibility).toHaveBeenCalled());
    const call = setProjectVisibility.mock.calls[0] as unknown[];
    expect(call[2]).toBe("public");
    expect(call[3]).toBeFalsy();
  });
});
