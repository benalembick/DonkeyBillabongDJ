import { describe, expect, it } from "vitest";
import { keyBindingLabel } from "../src/input/keyboard";

describe("keyboard shortcut labels", () => {
  it("formats letters, digits, arrows and modifiers for control hints", () => {
    expect(keyBindingLabel({ code: "KeyC", action: "cue" })).toBe("C");
    expect(keyBindingLabel({ code: "Digit1", shift: true, action: "hotcue" })).toBe("Shift+1");
    expect(keyBindingLabel({ code: "ArrowLeft", shift: true, action: "load" })).toBe("Shift+←");
    expect(keyBindingLabel({ code: "Space", ctrl: true, alt: true, action: "play" })).toBe("Ctrl/Cmd+Alt+Space");
  });
});
