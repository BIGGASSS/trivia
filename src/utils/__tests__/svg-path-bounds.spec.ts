import { describe, expect, it } from "vite-plus/test";
import { getLargestSubpathBounds, getPathSubpathBounds } from "../svg-path-bounds";

describe("getPathSubpathBounds", () => {
  it("computes the bounding box of a simple closed subpath", () => {
    const bounds = getPathSubpathBounds("M0,0 10,0 10,5 0,5Z");

    expect(bounds).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 5,
      area: 50,
    });
  });

  it("handles negative and decimal coordinates", () => {
    const bounds = getPathSubpathBounds("M-10.5,-2.25 -0.5,-2.25 -0.5,7.75Z");

    expect(bounds).toMatchObject({
      x: -10.5,
      y: -2.25,
      width: 10,
      height: 10,
    });
    expect(bounds?.area).toBeCloseTo(50);
  });

  it("handles scientific notation coordinates", () => {
    const bounds = getPathSubpathBounds("M1e1,0 2e1,0 2e1,1e1Z");

    expect(bounds).toMatchObject({ x: 10, y: 0, width: 10, height: 10 });
  });

  it("returns null when no coordinates are present", () => {
    expect(getPathSubpathBounds("Z")).toBeNull();
    expect(getPathSubpathBounds("")).toBeNull();
  });

  it("falls back to width*height when the polygon area is degenerate", () => {
    // Two points describe a zero-area polygon.
    const bounds = getPathSubpathBounds("M0,0 4,2Z");

    expect(bounds?.area).toBe(8);
  });
});

describe("getLargestSubpathBounds", () => {
  it("selects the largest subpath (mainland) of a multi-part country", () => {
    const smallIsland = "M100,100 101,100 101,101 100,101Z";
    const mainland = "M0,0 50,0 50,30 0,30Z";
    const bounds = getLargestSubpathBounds(`${smallIsland}${mainland}`);

    expect(bounds).toMatchObject({ x: 0, y: 0, width: 50, height: 30 });
  });

  it("returns null for empty paths", () => {
    expect(getLargestSubpathBounds("")).toBeNull();
  });
});
