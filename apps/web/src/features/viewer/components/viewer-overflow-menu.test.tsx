import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewerOverflowMenu } from "@/features/viewer/components/viewer-overflow-menu";
import { ThemeProvider } from "@/app/theme-provider";

// viewer-overflow-menu S-001 — the ⋯ button opens a real popover (replacing the dead placeholder
// toast). This file covers the menu SHELL: it opens, shows the Appearance group + the static footer,
// and dismisses on Escape without firing an action. The footer is phone-home-free — a plain repo
// link, no network on open (C-002). Anonymous gating (AS-002) lives in viewer-top-bar.test.tsx,
// where the top bar owns the `!anonymous` guard around the trigger.
//
// happy-dom has no layout; these tests assert the open/close state machine + content WIRING, not
// placement (radix portals the content into document.body, queried via `screen`).

const DOC = { title: "Web-core behavior contract", version: 4, kind: "markdown" as const };

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("vt-overflow"));
  await waitFor(() => expect(screen.getByTestId("viewer-overflow-content")).toBeInTheDocument());
  return user;
}

describe("ViewerOverflowMenu S-001 — menu shell", () => {
  it("AS-001: activating the ⋯ trigger opens a popover with the Appearance group and a footer", async () => {
    render(<ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />);

    // closed at rest
    expect(screen.queryByTestId("viewer-overflow-content")).toBeNull();

    await openMenu();

    // Appearance group present
    expect(screen.getByText(/appearance/i)).toBeInTheDocument();
    // footer present
    expect(screen.getByTestId("viewer-overflow-footer")).toBeInTheDocument();
  });

  it("AS-004: the footer is a static repo link and opening the menu makes no network request", async () => {
    const fetchSpy = mock(() => Promise.resolve(new Response("")));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      render(<ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />);
      await openMenu();

      const link = screen.getByTestId("viewer-overflow-repo-link") as HTMLAnchorElement;
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe("https://github.com/microvn/anchord/releases");
      // no telemetry / update probe on open
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("AS-003: pressing Escape dismisses the popover without firing an action", async () => {
    const onVersion = mock(() => {});
    render(<ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={onVersion} />);

    const user = await openMenu();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("viewer-overflow-content")).toBeNull());
    expect(onVersion).not.toHaveBeenCalled();
  });
});

// A controllable matchMedia for the System theme: returns one MediaQueryList whose `matches` we can
// flip, notifying registered change listeners — simulating the OS preference changing live.
function mockMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
    addListener: (cb: (e: { matches: boolean }) => void) => listeners.add(cb),
    removeListener: (cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
    dispatchEvent: () => true,
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = () => mql;
  return {
    flip(next: boolean) {
      mql.matches = next;
      listeners.forEach((cb) => cb({ matches: next }));
    },
  };
}

describe("ViewerOverflowMenu S-003 — document quick actions", () => {
  it("AS-009: Version history fires onVersion and closes the menu (the only mobile path to history)", async () => {
    const onVersion = mock(() => {});
    render(<ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={onVersion} />);

    const user = await openMenu();
    await user.click(screen.getByTestId("viewer-overflow-version"));

    expect(onVersion).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("viewer-overflow-content")).toBeNull());
  });

  it("AS-010: Copy link writes the current viewer URL to the clipboard", async () => {
    render(<ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />);

    const user = await openMenu();
    // Define the clipboard mock right before the click (happy-dom re-establishes navigator.clipboard
    // during render/userEvent, so an earlier define is clobbered — same pattern as share-dialog.test).
    const writeText = mock(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByTestId("viewer-overflow-copy-link"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // copies the address bar verbatim — on /s/:token that is the token URL, never the readable slug
    expect(writeText.mock.calls[0]?.[0]).toBe(window.location.href);
  });

  it("AS-011: Print / Save as PDF invokes the browser print dialog", async () => {
    const printSpy = mock(() => {});
    window.print = printSpy as unknown as typeof window.print;
    render(<ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />);

    const user = await openMenu();
    await user.click(screen.getByTestId("viewer-overflow-print"));

    expect(printSpy).toHaveBeenCalledTimes(1);
  });
});

describe("ViewerOverflowMenu S-005 — Download document wiring", () => {
  it("AS-015: Download document triggers a same-origin download to the slug's raw endpoint", async () => {
    // Capture the <a download> click without letting happy-dom navigate.
    const hrefs: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      hrefs.push(this.getAttribute("href") ?? "");
    };
    try {
      render(<ViewerOverflowMenu doc={DOC} slug="refund-api-spec" annotations={[]} onVersion={() => {}} />);
      const user = await openMenu();
      await user.click(screen.getByTestId("viewer-overflow-download-doc"));

      expect(hrefs).toEqual(["/api/docs/refund-api-spec/download"]);
      await waitFor(() => expect(screen.queryByTestId("viewer-overflow-content")).toBeNull());
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});

describe("ViewerOverflowMenu S-004 — Download annotations wiring", () => {
  it("AS-012: choosing Download annotations triggers a file download named from the doc title", async () => {
    const createObjectURL = mock(() => "blob:mock");
    const revokeObjectURL = mock(() => {});
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;

    // Capture the <a download> click without letting happy-dom attempt a navigation.
    const downloads: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.getAttribute("download") ?? "");
    };

    try {
      render(<ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />);
      const user = await openMenu();
      await user.click(screen.getByTestId("viewer-overflow-download"));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      // the Blob handed to the browser carries the Markdown export (C-004: built locally)
      expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
      expect(downloads).toEqual(["web-core-behavior-contract-annotations.md"]);
      // menu closes after the action
      await waitFor(() => expect(screen.queryByTestId("viewer-overflow-content")).toBeNull());
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});

// C-003: theme preference persists, the resolved theme is concrete, System follows the OS, and a
// fresh device resolves to dark — exercised across AS-005 / AS-006 / AS-008 below.
describe("ViewerOverflowMenu S-002 — Appearance control (theme)", () => {
  const originalMatchMedia = (window as unknown as { matchMedia?: unknown }).matchMedia;
  afterEach(() => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
    document.documentElement.removeAttribute("data-theme");
  });

  const theme = () => document.documentElement.getAttribute("data-theme");

  it("AS-005: choosing Light switches the chrome, marks Light active, and persists across reload", async () => {
    mockMatchMedia(true); // OS prefers dark — irrelevant once an explicit pick is made
    const { unmount } = render(
      <ThemeProvider>
        <ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />
      </ThemeProvider>,
    );
    // fresh device → dark canonical
    await waitFor(() => expect(theme()).toBe("dark"));

    const user = await openMenu();
    await user.click(screen.getByTestId("viewer-overflow-theme-light"));

    await waitFor(() => expect(theme()).toBe("light"));
    expect(localStorage.getItem("anchord-theme")).toBe("light");
    expect(screen.getByTestId("viewer-overflow-theme-light")).toHaveAttribute("aria-checked", "true");

    // reload: a fresh provider reads the saved preference → still light
    unmount();
    render(
      <ThemeProvider>
        <ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(theme()).toBe("light"));
  });

  it("AS-006: System resolves to the OS preference and re-resolves live when the OS flips", async () => {
    const mm = mockMatchMedia(true); // OS currently prefers dark
    render(
      <ThemeProvider>
        <ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />
      </ThemeProvider>,
    );
    const user = await openMenu();
    await user.click(screen.getByTestId("viewer-overflow-theme-system"));

    // follows the OS (dark)
    await waitFor(() => expect(theme()).toBe("dark"));
    expect(localStorage.getItem("anchord-theme")).toBe("system");
    expect(screen.getByTestId("viewer-overflow-theme-system")).toHaveAttribute("aria-checked", "true");

    // OS flips to light → chrome follows without re-opening the menu
    act(() => mm.flip(false));
    await waitFor(() => expect(theme()).toBe("light"));
  });

  it("AS-008: a fresh device with no saved preference resolves to dark, not System", async () => {
    mockMatchMedia(false); // OS prefers light
    render(
      <ThemeProvider>
        <ViewerOverflowMenu doc={DOC} slug="web-core" annotations={[]} onVersion={() => {}} />
      </ThemeProvider>,
    );
    // canonical dark despite the OS preferring light, and System is never auto-selected
    await waitFor(() => expect(theme()).toBe("dark"));
    const user = await openMenu();
    expect(screen.getByTestId("viewer-overflow-theme-dark")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("viewer-overflow-theme-system")).toHaveAttribute("aria-checked", "false");
  });
});
