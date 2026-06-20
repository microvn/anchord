import { describe, it, expect, mock } from "bun:test";
import { render, fireEvent, within } from "@testing-library/react";
import { GuestIdentityChip } from "./guest-identity-chip";

// annotation-core S-007 / AS-016 — the top-bar identity chip. For a guest it shows the session name +
// a Rename control (sits next to the Sign in CTA — wired in viewer-screen). Clicking Rename invokes
// the session rename. (The chip is presentational; useGuestIdentity owns the session-stable name +
// persistence — covered in use-guest-identity.test.ts.)

describe("GuestIdentityChip (S-007)", () => {
  it("AS-016: shows the session name + a Rename control", () => {
    const { getByTestId } = render(<GuestIdentityChip name="Anonymous Otter" onRename={() => {}} />);
    const chip = getByTestId("guest-id");
    expect(within(chip).getByTestId("guest-name")).toHaveTextContent("Anonymous Otter");
    expect(within(chip).getByTestId("guest-rename")).toBeTruthy();
  });

  it("AS-016: clicking Rename calls onRename", () => {
    const onRename = mock(() => {});
    const { getByTestId } = render(<GuestIdentityChip name="Anonymous Otter" onRename={onRename} />);
    fireEvent.click(getByTestId("guest-rename"));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("AS-019: a markup-bearing name renders inert (no live element from the name)", () => {
    const { getByTestId } = render(
      <GuestIdentityChip name="<img src=x onerror=alert(1)>" onRename={() => {}} />,
    );
    const nameEl = getByTestId("guest-name");
    expect(nameEl).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(nameEl.querySelector("img")).toBeNull();
  });
});
