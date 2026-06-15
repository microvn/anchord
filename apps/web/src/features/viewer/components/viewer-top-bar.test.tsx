import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewerTopBar } from "@/features/viewer/components/viewer-top-bar";
import { MetaStrip, type SpecMeta } from "@/features/viewer/components/meta-strip";

// annotation-core-ui S-005 — Viewer top bar + spec meta. The top bar is a pure presentational
// component driven by the doc meta the viewer already fetches (S-001) plus a `railVisible` /
// `onToggleRail` pair lifted into the viewer screen. These tests render the components directly
// (no router / query needed) and assert the identity fields + the comments-toggle behavior.
//
// AS-012: a live doc → bar shows title · Live badge · format · version; the comments toggle
//          flips the rail visibility (asserted via aria-pressed + the onToggleRail callback).
// AS-013: a spec doc (slug · version · updated · stories · AS · url, +Draft if draft) shows the
//          meta strip; a non-spec / plain doc shows no meta strip.

const liveDoc = {
  title: "Web-core behavior contract",
  kind: "markdown" as const,
  version: 4,
  status: "live",
  generalAccess: "restricted",
};

describe("ViewerTopBar S-005 (AS-012)", () => {
  it("AS-012: the top bar shows title, Live badge, format and version for a live doc", () => {
    render(
      <ViewerTopBar
        doc={liveDoc}
        railVisible
        onToggleRail={() => {}}
        onVersion={() => {}}
        onShare={() => {}}
      />,
    );

    // title
    expect(screen.getByTestId("vt-title")).toHaveTextContent("Web-core behavior contract");
    // Live badge — only when status is live/published
    expect(screen.getByTestId("vt-live-badge")).toHaveTextContent("Live");
    // format badge derived from kind (markdown → MD)
    expect(screen.getByTestId("vt-format-badge")).toHaveTextContent("MD");
    // version button shows the version
    expect(screen.getByTestId("vt-version")).toHaveTextContent("v4");
  });

  it("AS-012: a non-live doc (draft) shows no Live badge", () => {
    render(
      <ViewerTopBar
        doc={{ ...liveDoc, status: "draft" }}
        railVisible
        onToggleRail={() => {}}
        onVersion={() => {}}
        onShare={() => {}}
      />,
    );
    expect(screen.queryByTestId("vt-live-badge")).toBeNull();
  });

  it("AS-012: the comments toggle reflects + flips rail visibility", async () => {
    let visible = true;
    const onToggleRail = () => {
      visible = !visible;
    };

    const { rerender } = render(
      <ViewerTopBar
        doc={liveDoc}
        railVisible
        onToggleRail={onToggleRail}
        onVersion={() => {}}
        onShare={() => {}}
      />,
    );

    const toggle = screen.getByTestId("vt-comments-toggle");
    // visible → the toggle reads as pressed (rail shown)
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);
    expect(visible).toBe(false); // the callback flipped the lifted state

    // re-render with the flipped state → the toggle now reads as not-pressed (rail hidden)
    rerender(
      <ViewerTopBar
        doc={liveDoc}
        railVisible={false}
        onToggleRail={onToggleRail}
        onVersion={() => {}}
        onShare={() => {}}
      />,
    );
    expect(screen.getByTestId("vt-comments-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("AS-029: an anonymous visitor sees the doc title + a Sign in CTA, and no session-only chrome", async () => {
    let signedInClicked = false;
    render(
      <ViewerTopBar
        doc={liveDoc}
        railVisible
        onToggleRail={() => {}}
        onVersion={() => {}}
        onShare={() => {}}
        // even if a stray showShare leaks through, the anon variant must hard-hide it.
        showShare
        anonymous
        onSignIn={() => {
          signedInClicked = true;
        }}
      />,
    );

    // The doc title still shows (reading works for an anon).
    expect(screen.getByTestId("vt-title")).toHaveTextContent("Web-core behavior contract");
    // A Sign in CTA is present…
    const signin = screen.getByTestId("vt-signin");
    expect(signin).toBeInTheDocument();
    await userEvent.click(signin);
    expect(signedInClicked).toBe(true);
    // …and the session-only chrome is hidden: no Share, no account/overflow (member) menu.
    expect(screen.queryByTestId("vt-share")).toBeNull();
    expect(screen.queryByTestId("vt-overflow")).toBeNull();
  });

  it("AS-012: the format badge maps html and image kinds", () => {
    const { rerender } = render(
      <ViewerTopBar
        doc={{ ...liveDoc, kind: "html" }}
        railVisible
        onToggleRail={() => {}}
        onVersion={() => {}}
        onShare={() => {}}
      />,
    );
    expect(screen.getByTestId("vt-format-badge")).toHaveTextContent("HTML");

    rerender(
      <ViewerTopBar
        doc={{ ...liveDoc, kind: "image" }}
        railVisible
        onToggleRail={() => {}}
        onVersion={() => {}}
        onShare={() => {}}
      />,
    );
    expect(screen.getByTestId("vt-format-badge")).toHaveTextContent("IMG");
  });
});

describe("MetaStrip S-005 (AS-013)", () => {
  const specMeta: SpecMeta = {
    slug: "web-core",
    version: 4,
    updated: "12m ago",
    stories: 6,
    asCount: 23,
    url: "anchord.local/d/web-core",
    draft: false,
  };

  it("AS-013: a spec doc shows the meta strip with slug, version, updated, stories, AS and url", () => {
    render(<MetaStrip spec={specMeta} />);

    const strip = screen.getByTestId("meta-strip");
    expect(strip).toHaveTextContent("web-core"); // slug
    expect(strip).toHaveTextContent("v4"); // version
    expect(strip).toHaveTextContent("12m ago"); // updated
    expect(strip).toHaveTextContent("6"); // stories
    expect(screen.getByTestId("meta-stories")).toHaveTextContent("6");
    expect(screen.getByTestId("meta-as")).toHaveTextContent("23"); // AS count
    expect(strip).toHaveTextContent("anchord.local/d/web-core"); // url
    // not a draft → no Draft badge
    expect(screen.queryByTestId("meta-draft")).toBeNull();
  });

  it("AS-013: a draft spec doc shows the Draft badge", () => {
    render(<MetaStrip spec={{ ...specMeta, draft: true }} />);
    expect(screen.getByTestId("meta-draft")).toHaveTextContent("Draft");
  });

  it("AS-013: a non-spec / plain doc (no spec meta) shows no meta strip", () => {
    const { container } = render(<MetaStrip spec={null} />);
    expect(screen.queryByTestId("meta-strip")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("AS-013: stories / AS counts are optional — when absent, those cells are omitted but the strip still renders", () => {
    render(<MetaStrip spec={{ slug: "web-core", version: 4, url: "anchord.local/d/web-core" }} />);
    expect(screen.getByTestId("meta-strip")).toBeInTheDocument();
    expect(screen.queryByTestId("meta-stories")).toBeNull();
    expect(screen.queryByTestId("meta-as")).toBeNull();
  });
});
