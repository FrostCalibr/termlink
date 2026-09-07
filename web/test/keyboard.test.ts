import { describe, it, expect, vi } from "vitest";
import { handleCustomKey, type ClipboardApi } from "../src/views.js";

function makeKeyboardEvent(init: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  type?: string;
}): KeyboardEvent {
  let defaultPrevented = false;
  return {
    type: init.type ?? "keydown",
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  } as unknown as KeyboardEvent;
}

function mockTerminal(hasSelection = false, selectionText = "") {
  return {
    hasSelection: () => hasSelection,
    getSelection: () => selectionText,
  };
}

function mockSession() {
  const sentInput: Uint8Array[] = [];
  return {
    sentInput,
    sendInput: (bytes: Uint8Array) => sentInput.push(bytes),
  };
}

describe("Keyboard & Clipboard handling (handleCustomKey)", () => {
  it("copies selected text on Ctrl+Shift+C", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard: ClipboardApi = { writeText };

    const ev = makeKeyboardEvent({ key: "C", ctrlKey: true, shiftKey: true });
    const term = mockTerminal(true, "copied text from terminal");
    const session = mockSession();

    const handled = handleCustomKey(ev, term as any, session as any, clipboard);

    expect(handled).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("copied text from terminal");
  });

  it("does not copy on Ctrl+Shift+C if no text is selected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard: ClipboardApi = { writeText };

    const ev = makeKeyboardEvent({ key: "c", ctrlKey: true, shiftKey: true });
    const term = mockTerminal(false, "");
    const session = mockSession();

    const handled = handleCustomKey(ev, term as any, session as any, clipboard);

    expect(handled).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("pastes clipboard text into terminal stdin on Ctrl+Shift+V", async () => {
    const readText = vi.fn().mockResolvedValue("pasted terminal input");
    const clipboard: ClipboardApi = { readText };

    const ev = makeKeyboardEvent({ key: "V", ctrlKey: true, shiftKey: true });
    const term = mockTerminal();
    const session = mockSession();

    const handled = handleCustomKey(ev, term as any, session as any, clipboard);

    expect(handled).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(readText).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 10));

    expect(session.sentInput.length).toBe(1);
    const text = new TextDecoder().decode(session.sentInput[0]);
    expect(text).toBe("pasted terminal input");
  });

  it("leaves browser-reserved shortcuts untouched (returns false)", () => {
    const term = mockTerminal();
    const session = mockSession();

    const reservedKeys = [
      makeKeyboardEvent({ key: "t", ctrlKey: true }),
      makeKeyboardEvent({ key: "n", ctrlKey: true }),
      makeKeyboardEvent({ key: "w", ctrlKey: true }),
      makeKeyboardEvent({ key: "r", ctrlKey: true }),
      makeKeyboardEvent({ key: "p", ctrlKey: true }),
      makeKeyboardEvent({ key: "F11" }),
      makeKeyboardEvent({ key: "F12" }),
      makeKeyboardEvent({ key: "Tab", ctrlKey: true }),
    ];

    for (const ev of reservedKeys) {
      expect(handleCustomKey(ev, term as any, session as any)).toBe(false);
      expect(ev.defaultPrevented).toBe(false);
    }
  });

  it("passes through standard control and navigation keys to xterm.js (returns true)", () => {
    const term = mockTerminal();
    const session = mockSession();

    const standardKeys = [
      makeKeyboardEvent({ key: "c", ctrlKey: true }), // Ctrl+C (SIGINT)
      makeKeyboardEvent({ key: "d", ctrlKey: true }), // Ctrl+D (EOF)
      makeKeyboardEvent({ key: "z", ctrlKey: true }), // Ctrl+Z (SIGTSTP)
      makeKeyboardEvent({ key: "ArrowUp" }),
      makeKeyboardEvent({ key: "ArrowDown" }),
      makeKeyboardEvent({ key: "ArrowLeft" }),
      makeKeyboardEvent({ key: "ArrowRight" }),
      makeKeyboardEvent({ key: "Home" }),
      makeKeyboardEvent({ key: "End" }),
      makeKeyboardEvent({ key: "PageUp" }),
      makeKeyboardEvent({ key: "PageDown" }),
      makeKeyboardEvent({ key: "Escape" }),
      makeKeyboardEvent({ key: "Tab" }),
      makeKeyboardEvent({ key: "Backspace" }),
      makeKeyboardEvent({ key: "F1" }),
    ];

    for (const ev of standardKeys) {
      expect(handleCustomKey(ev, term as any, session as any)).toBe(true);
      expect(ev.defaultPrevented).toBe(false);
    }
  });

  it("prevents browser quit on Ctrl+Q while allowing xterm.js to handle 0x11 (returns true)", () => {
    const term = mockTerminal();
    const session = mockSession();
    const ev = makeKeyboardEvent({ key: "q", ctrlKey: true });

    const handled = handleCustomKey(ev, term as any, session as any);

    expect(handled).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("handles clipboard read failure gracefully", async () => {
    const readText = vi.fn().mockRejectedValue(new Error("Clipboard access denied"));
    const clipboard: ClipboardApi = { readText };

    const ev = makeKeyboardEvent({ key: "v", ctrlKey: true, shiftKey: true });
    const term = mockTerminal();
    const session = mockSession();

    expect(() => handleCustomKey(ev, term as any, session as any, clipboard)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(session.sentInput.length).toBe(0);
  });
});
