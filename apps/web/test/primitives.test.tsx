import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { FormatBadge } from "../src/components/format-badge";
import { AccessIndicator } from "../src/components/access-indicator";

// Shared chrome primitives (S-003). Each renders the correct label per prop and falls back
// safely (no crash, never blank) on an unknown/empty prop. These are owned by web-core so
// every feature screen reuses one badge/indicator.
describe("web-core S-003 — FormatBadge primitive (AS-009/C-003)", () => {
  it("C-003: renders the right label for html / markdown / image", () => {
    const { rerender } = render(<FormatBadge format="html" />);
    expect(screen.getByText("HTML")).toBeInTheDocument();
    rerender(<FormatBadge format="markdown" />);
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    rerender(<FormatBadge format="image" />);
    expect(screen.getByText("Image")).toBeInTheDocument();
  });

  it("C-003: an unknown or empty format renders a safe fallback, never crashes or goes blank", () => {
    const { rerender } = render(<FormatBadge format="pdf" />);
    expect(screen.getByText("Doc")).toBeInTheDocument();
    rerender(<FormatBadge format="" />);
    expect(screen.getByText("Doc")).toBeInTheDocument();
    rerender(<FormatBadge format={null} />);
    expect(screen.getByText("Doc")).toBeInTheDocument();
    rerender(<FormatBadge />);
    expect(screen.getByText("Doc")).toBeInTheDocument();
  });
});

describe("web-core S-003 — AccessIndicator primitive (AS-009/C-003)", () => {
  it("C-003: renders the right label for restricted / workspace / link", () => {
    const { rerender } = render(<AccessIndicator access="restricted" />);
    expect(screen.getByText("Restricted")).toBeInTheDocument();
    rerender(<AccessIndicator access="workspace" />);
    expect(screen.getByText("Anyone in workspace")).toBeInTheDocument();
    rerender(<AccessIndicator access="link" />);
    expect(screen.getByText("Anyone with link")).toBeInTheDocument();
  });

  it("C-003: only the link-shared state uses the teal accent; restricted/workspace stay muted", () => {
    const { rerender, container } = render(<AccessIndicator access="link" />);
    expect(container.firstChild).toHaveClass("text-accent");
    rerender(<AccessIndicator access="restricted" />);
    expect(container.firstChild).toHaveClass("text-muted");
  });

  it("C-003: an unknown or empty access level renders a safe fallback, never crashes", () => {
    const { rerender } = render(<AccessIndicator access="public-ish" />);
    expect(screen.getByText("Unknown access")).toBeInTheDocument();
    rerender(<AccessIndicator access="" />);
    expect(screen.getByText("Unknown access")).toBeInTheDocument();
    rerender(<AccessIndicator access={null} />);
    expect(screen.getByText("Unknown access")).toBeInTheDocument();
    rerender(<AccessIndicator />);
    expect(screen.getByText("Unknown access")).toBeInTheDocument();
  });
});
