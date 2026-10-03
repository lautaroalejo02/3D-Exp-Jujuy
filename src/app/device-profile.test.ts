import { describe, expect, it } from "vitest";

import {
  MOBILE_DPR_MAX,
  DESKTOP_DPR_MAX,
  planRender,
  profileOverrideFromSearch,
  selectDeviceProfile,
} from "./device-profile";

describe("profileOverrideFromSearch", () => {
  it("maps ?perfil=movil to mobile", () => {
    expect(profileOverrideFromSearch("?perfil=movil")).toBe("mobile");
  });

  it("maps ?perfil=escritorio to desktop", () => {
    expect(profileOverrideFromSearch("?perfil=escritorio")).toBe("desktop");
  });

  it("ignores other values and missing params", () => {
    expect(profileOverrideFromSearch("?perfil=tablet")).toBeUndefined();
    expect(profileOverrideFromSearch("?calidad=alta")).toBeUndefined();
    expect(profileOverrideFromSearch("")).toBeUndefined();
  });

  it("works alongside other params", () => {
    expect(profileOverrideFromSearch("?calidad=alta&perfil=movil&debug=1")).toBe(
      "mobile",
    );
  });
});

describe("selectDeviceProfile", () => {
  it("is desktop with a fine pointer and a large screen", () => {
    expect(
      selectDeviceProfile({ coarsePointer: false, smallerSideCssPx: 1080 }),
    ).toBe("desktop");
  });

  it("is mobile with a coarse pointer and a small screen (phone)", () => {
    expect(
      selectDeviceProfile({ coarsePointer: true, smallerSideCssPx: 393 }),
    ).toBe("mobile");
  });

  it("is mobile at the small-screen boundary minus epsilon", () => {
    expect(
      selectDeviceProfile({ coarsePointer: true, smallerSideCssPx: 899 }),
    ).toBe("mobile");
    expect(
      selectDeviceProfile({ coarsePointer: true, smallerSideCssPx: 900 }),
    ).toBe("desktop");
  });

  it("is desktop with a coarse pointer on a large screen (big tablet)", () => {
    expect(
      selectDeviceProfile({ coarsePointer: true, smallerSideCssPx: 1024 }),
    ).toBe("desktop");
  });

  it("is desktop with a small window on a desktop-class pointer", () => {
    expect(
      selectDeviceProfile({ coarsePointer: false, smallerSideCssPx: 500 }),
    ).toBe("desktop");
  });

  it("is mobile on a small low-memory device even without a coarse pointer", () => {
    expect(
      selectDeviceProfile({
        coarsePointer: false,
        smallerSideCssPx: 800,
        deviceMemoryGb: 4,
      }),
    ).toBe("mobile");
  });

  it("does not mark large devices by memory alone", () => {
    expect(
      selectDeviceProfile({
        coarsePointer: false,
        smallerSideCssPx: 1200,
        deviceMemoryGb: 2,
      }),
    ).toBe("desktop");
  });
});

describe("planRender", () => {
  const halfRes = { width: 1216, height: 1280 };
  const fullRes = { width: 2432, height: 2560 };

  it("desktop default: half-res mesh, DPR cap 2, no warning", () => {
    const plan = planRender("desktop", "default", halfRes);
    expect(plan.mesh).toEqual({ width: 608, height: 640 });
    expect(plan.dprMax).toBe(DESKTOP_DPR_MAX);
    expect(plan.warnHighQuality).toBe(false);
    expect(plan.profile).toBe("desktop");
  });

  it("desktop high: full half-grid mesh, DPR cap 2", () => {
    const plan = planRender("desktop", "high", fullRes);
    expect(plan.mesh).toEqual({ width: 1216, height: 1280 });
    expect(plan.dprMax).toBe(DESKTOP_DPR_MAX);
    expect(plan.warnHighQuality).toBe(false);
  });

  it("mobile default: quarter-res mesh 304x320, DPR cap 1.5", () => {
    const plan = planRender("mobile", "default", halfRes);
    expect(plan.mesh).toEqual({ width: 304, height: 320 });
    expect(plan.dprMax).toBe(MOBILE_DPR_MAX);
    expect(plan.warnHighQuality).toBe(false);
  });

  it("mobile high: 608x640 mesh, DPR cap 1.5, warns", () => {
    const plan = planRender("mobile", "high", fullRes);
    expect(plan.mesh).toEqual({ width: 608, height: 640 });
    expect(plan.dprMax).toBe(MOBILE_DPR_MAX);
    expect(plan.warnHighQuality).toBe(true);
  });

  it("clamps tiny grids to at least 2 vertices per side", () => {
    const plan = planRender("mobile", "default", { width: 4, height: 4 });
    expect(plan.mesh.width).toBeGreaterThanOrEqual(2);
    expect(plan.mesh.height).toBeGreaterThanOrEqual(2);
  });
});
