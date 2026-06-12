import { describe, it, expect } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// sharing-permissions-ui S-004 — People list with role + pending (AS-014). PeopleList is a pure
// presentational component (no client calls), so it's exercised directly: an owner row shows a
// static "Owner" label with no dropdown (C-004); an active non-owner shows an editable role
// dropdown (viewer|commenter|editor); a pending invitee shows the "Pending" tag.

import { PeopleList } from "@/features/sharing/people-list";
import type { SharePerson } from "@/features/sharing/client";

const PEOPLE: SharePerson[] = [
  { userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner", status: "active" },
  { userId: "u-ed", email: "ed@acme.com", name: "Ed Editor", role: "editor", status: "active" },
  { email: "bob@x.com", role: "commenter", status: "pending" },
];

describe("Sharing S-004 — people list", () => {
  it("AS-014: renders rows with role + pending; owner static, active editable, pending tagged", () => {
    render(<PeopleList people={PEOPLE} />);

    // three rows, one per person.
    expect(screen.getByTestId("share-person-owner@acme.com")).toBeInTheDocument();
    expect(screen.getByTestId("share-person-ed@acme.com")).toBeInTheDocument();
    expect(screen.getByTestId("share-person-bob@x.com")).toBeInTheDocument();

    // owner → static "Owner" label, NO role dropdown (C-004).
    const ownerRow = screen.getByTestId("share-person-owner@acme.com");
    expect(within(ownerRow).getByTestId("share-person-role-owner@acme.com")).toHaveTextContent("Owner");
    expect(screen.queryByTestId("share-person-role-trigger-owner@acme.com")).toBeNull();

    // active non-owner → editable role dropdown showing the current role.
    const edRow = screen.getByTestId("share-person-ed@acme.com");
    const edTrigger = within(edRow).getByTestId("share-person-role-trigger-ed@acme.com");
    expect(edTrigger).toBeInTheDocument();
    expect(edTrigger).toHaveTextContent("Editor");

    // pending invitee → Pending tag.
    const bobRow = screen.getByTestId("share-person-bob@x.com");
    expect(within(bobRow).getByTestId("share-person-pending-bob@x.com")).toHaveTextContent("Pending");
    // a pending invitee is not the owner → still gets the editable dropdown (not a static label).
    expect(within(bobRow).getByTestId("share-person-role-trigger-bob@x.com")).toBeInTheDocument();
  });
});
