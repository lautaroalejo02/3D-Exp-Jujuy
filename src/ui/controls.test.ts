import { describe, expect, it } from "vitest";

import { qualityToggleLabel } from "./controls";

describe("qualityToggleLabel", () => {
  it("shows the current state and the action for normal quality", () => {
    expect(qualityToggleLabel("default")).toBe(
      "Calidad: normal · Cambiar a alta",
    );
  });

  it("shows the current state and the action for high quality", () => {
    expect(qualityToggleLabel("high")).toBe("Calidad: alta · Cambiar a normal");
  });
});
