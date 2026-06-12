import { describe, it, expect, beforeEach } from "bun:test";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui S-002 — Navigate the doc with the outline (TOC).
// G6: the FE derives the outline from h1–h3 headings in the rendered doc content; there is no
// backend outline payload and no priority badges in v0.
//
// AS-005 (render): the TocSidebar lists the doc's headings and clicking an entry scrolls that
//   heading into view. happy-dom has no layout, so we assert the jump by spying on the heading's
//   scrollIntoView (the jump target), not on a real scroll position.
// AS-006 (unit): pickActiveHeading is the pure scroll-spy core — given each heading's offsetTop
//   and the current scrollTop, it returns the id of the section currently at/above the viewport
//   top. Pure so it is testable without real layout.

import { TocSidebar, extractHeadings, pickActiveHeading } from "@/features/viewer/toc-sidebar";

function mountDoc(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("extractHeadings (S-002, G6)", () => {
  it("AS-005: derives {id,text,level} from h1–h3, using id or data-block-id, skipping h4+", () => {
    const host = mountDoc(
      `<h1 id="block-h1-1">Title</h1>
       <h2 id="block-h2-1">Intro</h2>
       <h3 data-block-id="block-h3-1">Details</h3>
       <h4 id="block-h4-1">Too deep</h4>
       <h2>No id at all</h2>`,
    );

    const headings = extractHeadings(host);

    expect(headings).toEqual([
      { id: "block-h1-1", text: "Title", level: 1 },
      { id: "block-h2-1", text: "Intro", level: 2 },
      { id: "block-h3-1", text: "Details", level: 3 },
    ]);
  });
});

describe("pickActiveHeading (S-002 scroll-spy core)", () => {
  const headings = [
    { id: "h-1", text: "One", level: 1, offsetTop: 0 },
    { id: "h-2", text: "Two", level: 2, offsetTop: 200 },
    { id: "h-3", text: "Three", level: 2, offsetTop: 400 },
  ];

  it("AS-006: returns the first heading when scrolled to the very top", () => {
    expect(pickActiveHeading(headings, 0)).toBe("h-1");
  });

  it("AS-006: marks the section currently at/above the viewport top active when scrolled past it", () => {
    // Scrolled past section 2's heading (200) but not yet to section 3 (400).
    expect(pickActiveHeading(headings, 250)).toBe("h-2");
    // Scrolled past section 3 → section 3 active.
    expect(pickActiveHeading(headings, 420)).toBe("h-3");
  });

  it("AS-006: keeps the last heading active past the end and tolerates an empty list", () => {
    expect(pickActiveHeading(headings, 9999)).toBe("h-3");
    expect(pickActiveHeading([], 100)).toBeNull();
  });
});

describe("TocSidebar (S-002)", () => {
  it("AS-005: lists the doc headings and clicking one scrolls that heading into view", async () => {
    const host = mountDoc(
      `<h1 id="block-h1-1">Overview</h1>
       <h2 id="block-h2-1">Background</h2>
       <h2 id="block-h2-2">Approach</h2>
       <h2 id="block-h2-3">Results</h2>
       <h2 id="block-h2-4">Conclusion</h2>`,
    );
    const target = host.querySelector<HTMLElement>("#block-h2-3")!;
    let scrolled = 0;
    target.scrollIntoView = () => {
      scrolled += 1;
    };

    render(<TocSidebar contentEl={host} activeId={null} onActiveChange={() => {}} />);
    // Scope queries to the sidebar — the mounted doc shares the same heading text in the DOM.
    const toc = within(screen.getByTestId("toc-sidebar"));

    // All five headings are listed as outline entries.
    expect(toc.getByText("Overview")).toBeInTheDocument();
    expect(toc.getByText("Results")).toBeInTheDocument();

    await userEvent.click(toc.getByText("Approach"));
    expect(host.querySelector("#block-h2-2")).toBeTruthy();

    await userEvent.click(toc.getByText("Results"));
    expect(scrolled).toBe(1);
  });

  it("AS-005: re-derives the outline when doc content arrives after mount (loading→loaded race)", async () => {
    // The viewer's <main> scroll container mounts empty (skeleton) and keeps the same element
    // identity when the doc content swaps in after the query resolves. The TOC must re-extract
    // headings when the content inside contentEl changes, not only when contentEl's identity does.
    const host = mountDoc("");

    render(<TocSidebar contentEl={host} activeId={null} onActiveChange={() => {}} />);
    const toc = within(screen.getByTestId("toc-sidebar"));

    // Nothing to list while the pane is still empty.
    expect(toc.queryByText("A")).toBeNull();

    // Doc content swaps in after mount — same contentEl, new children.
    act(() => {
      host.innerHTML = '<h1 id="a">A</h1><h2 id="b">B</h2>';
    });

    expect(await toc.findByText("A")).toBeInTheDocument();
    expect(await toc.findByText("B")).toBeInTheDocument();
  });

  it("AS-005: the search filter narrows the listed entries", async () => {
    const host = mountDoc(
      `<h2 id="a">Background</h2>
       <h2 id="b">Approach</h2>
       <h2 id="c">Results</h2>`,
    );

    render(<TocSidebar contentEl={host} activeId={null} onActiveChange={() => {}} />);
    const toc = within(screen.getByTestId("toc-sidebar"));

    await userEvent.type(screen.getByPlaceholderText("Filter outline…"), "appr");

    expect(toc.getByText("Approach")).toBeInTheDocument();
    expect(toc.queryByText("Background")).toBeNull();
    expect(toc.queryByText("Results")).toBeNull();
  });
});
