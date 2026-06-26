import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { PublishAccessNotice } from "@/features/docs/components/publish-access-notice";
import type { GeneralAccess } from "@/features/docs/types";

// project-visibility-fe S-004 — the post-publish PublishAccessNotice. A pure presentational component
// rendered directly (no client/sonner mock needed): it DISPLAYS the publish response's `project` +
// `access` (C-001), and is null-safe when either is absent/null/unrecognized (AS-017). No backend.

describe("project-visibility-fe S-004 — PublishAccessNotice", () => {
  it("AS-016: reports the target project (emphasized) and maps each access level to its copy", () => {
    // anyone_in_workspace → "visible to your workspace"
    const { rerender } = render(
      <PublishAccessNotice project={{ id: "p1", name: "Your docs" }} access="anyone_in_workspace" />,
    );
    let notice = screen.getByTestId("publish-access-notice");
    expect(notice).toHaveTextContent("in Your docs · visible to your workspace");
    // The project name is emphasized (the "in **<project>**" of the spec copy).
    expect(screen.getByText("Your docs").tagName).toBe("STRONG");

    // restricted → "private — only you"
    rerender(<PublishAccessNotice project={{ id: "p1", name: "Secret" }} access="restricted" />);
    notice = screen.getByTestId("publish-access-notice");
    expect(notice).toHaveTextContent("in Secret · private — only you");

    // anyone_with_link → "anyone with the link"
    rerender(<PublishAccessNotice project={{ id: "p1", name: "Open" }} access="anyone_with_link" />);
    notice = screen.getByTestId("publish-access-notice");
    expect(notice).toHaveTextContent("in Open · anyone with the link");
  });

  it("AS-017: null-safe — omits the project clause for null project / null name, omits an unrecognized access, never crashes", () => {
    // project: null → access clause only, no "in ****", no bold name.
    const { rerender } = render(<PublishAccessNotice project={null} access="restricted" />);
    let notice = screen.getByTestId("publish-access-notice");
    expect(notice).toHaveTextContent("· private — only you");
    expect(notice.querySelector("strong")).toBeNull();
    expect(notice).not.toHaveTextContent(/\bin\b/);

    // project.name: null → still no project clause, access clause shows.
    rerender(<PublishAccessNotice project={{ id: "p1", name: null }} access="anyone_in_workspace" />);
    notice = screen.getByTestId("publish-access-notice");
    expect(notice).toHaveTextContent("· visible to your workspace");
    expect(notice.querySelector("strong")).toBeNull();

    // unrecognized access → project shows, access clause omitted (no garbage, no "·").
    rerender(
      <PublishAccessNotice
        project={{ id: "p1", name: "Team" }}
        access={"who_knows" as GeneralAccess}
      />,
    );
    notice = screen.getByTestId("publish-access-notice");
    expect(notice).toHaveTextContent("in Team");
    expect(notice).not.toHaveTextContent("·");
  });

  it("AS-017: renders nothing (no crash) when both project and access are absent", () => {
    const { container } = render(<PublishAccessNotice project={null} />);
    expect(screen.queryByTestId("publish-access-notice")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
