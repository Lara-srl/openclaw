import { describe, expect, it } from "vitest";
import { AdaUiState, buildUiState } from "./ui-state.js";

describe("buildUiState", () => {
  it("builds minimal frame with only state", () => {
    const frame = JSON.parse(buildUiState(AdaUiState.IDLE));
    expect(frame).toEqual({ type: "SET_UI", state: 100, brightness: 255 });
  });

  it("includes text only when provided", () => {
    const withText = JSON.parse(buildUiState(AdaUiState.THINKING, { text: "Sto pensando..." }));
    expect(withText.text).toBe("Sto pensando...");

    const without = JSON.parse(buildUiState(AdaUiState.THINKING));
    expect(without).not.toHaveProperty("text");
  });

  it("includes icon only when provided", () => {
    const withIcon = JSON.parse(buildUiState(AdaUiState.ACTING, { icon: "search" }));
    expect(withIcon.icon).toBe("search");

    const without = JSON.parse(buildUiState(AdaUiState.ACTING));
    expect(without).not.toHaveProperty("icon");
  });

  it("defaults brightness to 255", () => {
    const frame = JSON.parse(buildUiState(AdaUiState.SPEAKING));
    expect(frame.brightness).toBe(255);
  });

  it("allows custom brightness", () => {
    const frame = JSON.parse(buildUiState(AdaUiState.IDLE, { brightness: 128 }));
    expect(frame.brightness).toBe(128);
  });

  it("produces valid JSON string", () => {
    const raw = buildUiState(AdaUiState.LISTENING);
    expect(typeof raw).toBe("string");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("covers all state codes", () => {
    const codes = [
      AdaUiState.BOOT,
      AdaUiState.IDLE,
      AdaUiState.LISTENING,
      AdaUiState.THINKING,
      AdaUiState.ACTING,
      AdaUiState.SPEAKING,
      AdaUiState.COMPACTION,
      AdaUiState.SHUTDOWN,
    ];
    expect(codes).toEqual([0, 100, 200, 300, 400, 500, 600, 900]);
    for (const code of codes) {
      const frame = JSON.parse(buildUiState(code));
      expect(frame.type).toBe("SET_UI");
      expect(frame.state).toBe(code);
    }
  });
});
