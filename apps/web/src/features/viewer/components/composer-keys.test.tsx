import { describe, it, expect, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { Composer } from "./composer";

// Comment-composer focus + key bindings (request 2026-06-20):
//   - the textarea autofocuses on open (caret at the end, so a prefilled body is ready to append to)
//   - Shift+Enter POSTS the comment; a plain Enter inserts a newline (does NOT post)
// (This is the reverse of the common Enter-to-send convention — intentional so multi-line comments
//  type naturally; the deliberate post action is Shift+Enter.)

describe("Composer focus + key bindings", () => {
  it("autofocuses the comment textarea on open, caret at the end", () => {
    const { getByTestId } = render(
      <Composer quote="the selected text" initialBody="hi" onSend={() => {}} onCancel={() => {}} />,
    );
    const ta = getByTestId("composer-input") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(ta);
    // caret placed at the end of the prefilled body ("hi" → 2)
    expect(ta.selectionStart).toBe(2);
    expect(ta.selectionEnd).toBe(2);
  });

  it("Shift+Enter posts the comment", () => {
    const onSend = mock((_body: string) => {});
    const { getByTestId } = render(
      <Composer quote="q" initialBody="ship it" onSend={onSend} onCancel={() => {}} />,
    );
    fireEvent.keyDown(getByTestId("composer-input"), { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe("ship it");
  });

  it("a plain Enter does NOT post (newline falls through to the textarea)", () => {
    const onSend = mock((_body: string) => {});
    const { getByTestId } = render(
      <Composer quote="q" initialBody="ship it" onSend={onSend} onCancel={() => {}} />,
    );
    fireEvent.keyDown(getByTestId("composer-input"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Shift+Enter does NOT post when the body is empty (mirrors the disabled Send)", () => {
    const onSend = mock((_body: string) => {});
    const { getByTestId } = render(<Composer quote="q" onSend={onSend} onCancel={() => {}} />);
    fireEvent.keyDown(getByTestId("composer-input"), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});
