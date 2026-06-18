import { describe, it, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// workspace-project-ui S-008 / C-007 — the shared numbered pagination control. Reused by all
// three browse lists. Hidden when there is one page or fewer; Previous disabled on page 1, Next
// disabled on the last page; clicking a number / Prev / Next reports the target page.
import { Pagination } from "./pagination";

describe("workspace-project-ui S-008 — shared Pagination control", () => {
  it("C-007: renders no control when totalPages <= 1", () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} onPageChange={() => {}} />,
    );
    expect(container.querySelector('[data-testid="pagination"]')).toBeNull();
    // also true for 0 pages (empty list)
    const { container: c0 } = render(
      <Pagination page={1} totalPages={0} onPageChange={() => {}} />,
    );
    expect(c0.querySelector('[data-testid="pagination"]')).toBeNull();
  });

  it("C-007: renders Previous/Next plus a button per page", () => {
    render(<Pagination page={1} totalPages={3} onPageChange={() => {}} />);
    expect(screen.getByTestId("pagination")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-prev")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-next")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-page-1")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-page-2")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-page-3")).toBeInTheDocument();
  });

  it("C-007: Previous is disabled on page 1, Next on the last page", () => {
    const { rerender } = render(
      <Pagination page={1} totalPages={3} onPageChange={() => {}} />,
    );
    expect(screen.getByTestId("pagination-prev")).toBeDisabled();
    expect(screen.getByTestId("pagination-next")).not.toBeDisabled();

    rerender(<Pagination page={3} totalPages={3} onPageChange={() => {}} />);
    expect(screen.getByTestId("pagination-next")).toBeDisabled();
    expect(screen.getByTestId("pagination-prev")).not.toBeDisabled();
  });

  it("C-007: clicking a page number / Next reports the target page", async () => {
    const onPageChange = mock(() => {});
    const user = userEvent.setup();
    render(<Pagination page={1} totalPages={3} onPageChange={onPageChange} />);
    await user.click(screen.getByTestId("pagination-page-3"));
    expect(onPageChange).toHaveBeenCalledWith(3);
    await user.click(screen.getByTestId("pagination-next"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});
