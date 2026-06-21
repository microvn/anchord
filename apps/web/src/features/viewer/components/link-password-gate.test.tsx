import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { LinkPasswordGate } from "./link-password-gate";

// capability-share-link S-006 / AS-017 / AS-018 — the password challenge UI as a pure controlled
// form. It does NOT fetch; the parent owns the redeem and feeds the outcome back as props. These
// unit tests prove: it prompts, submits the entered password, shows a wrong-password error and
// allows retry (AS-018), and disables submit once the parent reports the server throttled (AS-018).

describe("LinkPasswordGate (S-006)", () => {
  const onSubmit = mock((_pw: string) => {});
  beforeEach(() => onSubmit.mockClear());

  it("AS-017: shows the password prompt and submits the entered password", () => {
    render(<LinkPasswordGate onSubmit={onSubmit} />);
    expect(screen.getByTestId("link-password-gate")).toBeTruthy();
    const input = screen.getByTestId("link-password-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "letmein" } });
    fireEvent.click(screen.getByTestId("link-password-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("letmein");
  });

  it("AS-017.T1: an empty password cannot be submitted (submit disabled)", () => {
    render(<LinkPasswordGate onSubmit={onSubmit} />);
    const submit = screen.getByTestId("link-password-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("AS-018: a wrong password shows an inline error but the visitor can retry", () => {
    render(<LinkPasswordGate onSubmit={onSubmit} error="Incorrect password. Try again." />);
    expect(screen.getByTestId("link-password-error").textContent).toContain("Incorrect");
    // Still retryable — the field + submit are enabled.
    const input = screen.getByTestId("link-password-input") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "second-try" } });
    fireEvent.click(screen.getByTestId("link-password-submit"));
    expect(onSubmit).toHaveBeenCalledWith("second-try");
  });

  it("AS-018.T1: once throttled, submit is disabled and a back-off message shows", () => {
    render(<LinkPasswordGate onSubmit={onSubmit} rateLimited />);
    expect(screen.getByTestId("link-password-rate-limited")).toBeTruthy();
    const submit = screen.getByTestId("link-password-submit") as HTMLButtonElement;
    const input = screen.getByTestId("link-password-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "anything" } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("AS-017.T2: while submitting, the form is disabled (no double-submit)", () => {
    render(<LinkPasswordGate onSubmit={onSubmit} submitting />);
    const submit = screen.getByTestId("link-password-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Checking");
  });
});
