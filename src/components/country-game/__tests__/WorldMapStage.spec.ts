import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import WorldMapStage from "../WorldMapStage.vue";

const countries = [
  { id: "west", name: "West", path: "M-150,-10 -140,-10 -140,0 -150,0Z" },
  { id: "east", name: "East", path: "M140,20 150,20 150,30 140,30Z" },
  { id: "large", name: "Large", path: "M-40,-35 40,-35 40,35 -40,35Z" },
];

// jsdom does not implement SVG layout. Model xMidYMid meet using the actual
// rendered viewBox; deliberately use non-2:1 containers to expose letterboxing.
const installScreenTransform = (svg: SVGSVGElement, width = 800, height = 800) => {
  const left = 30;
  const top = 50;
  const getScreenCTM = vi.fn<
    () => { inverse: () => Pick<DOMMatrix, "a" | "b" | "c" | "d" | "e" | "f"> }
  >(() => {
    const [x = 0, y = 0, viewWidth = 360, viewHeight = 180] = (svg.getAttribute("viewBox") ?? "")
      .split(" ")
      .map(Number);
    const scale = Math.min(width / viewWidth, height / viewHeight);
    const translateX = left + (width - viewWidth * scale) / 2 - x * scale;
    const translateY = top + (height - viewHeight * scale) / 2 - y * scale;
    return {
      inverse: () => ({
        a: 1 / scale,
        b: 0,
        c: 0,
        d: 1 / scale,
        e: -translateX / scale,
        f: -translateY / scale,
      }),
    };
  });
  const setPointerCapture = vi.fn<(pointerId: number) => void>();
  const releasePointerCapture = vi.fn<(pointerId: number) => void>();
  Object.defineProperties(svg, {
    getScreenCTM: { configurable: true, value: getScreenCTM },
    getBoundingClientRect: { configurable: true, value: () => ({ left, top, width, height }) },
    setPointerCapture: { configurable: true, value: setPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { getScreenCTM, setPointerCapture, releasePointerCapture };
};

const pointer = (
  element: Element,
  type: string,
  id: number,
  x: number,
  y: number,
  pointerType = "touch",
  button = 0,
) => {
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: id,
      clientX: x,
      clientY: y,
      pointerType,
      button,
    }),
  );
};

const viewState = (wrapper: VueWrapper) => {
  const [x = 0, y = 0, width = 360, height = 180] = (wrapper.get("svg").attributes("viewBox") ?? "")
    .split(" ")
    .map(Number);
  return {
    x,
    y,
    width,
    height,
    zoom: 360 / width,
    centerX: x + width / 2,
    centerY: y + height / 2,
  };
};

describe("WorldMapStage", () => {
  let wrapper: VueWrapper;

  beforeEach(() => {
    vi.useFakeTimers();
    wrapper = mount(WorldMapStage, {
      props: {
        countries,
        selectedCountryId: null,
        answerState: "idle",
        missedTargetCountryId: null,
        guessingDisabled: false,
        revealTarget: null,
      },
      attachTo: document.body,
    });
  });

  afterEach(() => {
    wrapper.unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const zoomIn = async (times = 1) => {
    for (let index = 0; index < times; index += 1) {
      await wrapper.get('button[aria-label="Zoom in"]').trigger("click");
    }
  };

  it.each([
    [800, 800],
    [1200, 300],
  ])("pans using the inverse screen transform in a %sx%s viewport", async (width, height) => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    const { releasePointerCapture } = installScreenTransform(svg, width, height);
    await zoomIn(3);
    const initial = viewState(wrapper);
    const scale = Math.min(width / initial.width, height / initial.height);

    pointer(svg, "pointerdown", 1, 300, 300);
    pointer(svg, "pointermove", 1, 340, 340);
    await nextTick();
    expect(viewState(wrapper).centerX).toBeCloseTo(-40 / scale);
    expect(viewState(wrapper).centerY).toBeCloseTo(-40 / scale);

    // Updating the viewBox mid-drag must not feed the pan back into itself.
    pointer(svg, "pointermove", 1, 360, 360);
    await nextTick();
    expect(viewState(wrapper).centerX).toBeCloseTo(-60 / scale);
    expect(viewState(wrapper).centerY).toBeCloseTo(-60 / scale);
    pointer(svg, "pointerup", 1, 360, 360);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("includes rotated screen axes when panning", async () => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    const { getScreenCTM } = installScreenTransform(svg);
    await zoomIn(3);
    getScreenCTM.mockReturnValue({ inverse: () => ({ a: 0, b: -0.2, c: 0.2, d: 0, e: 0, f: 0 }) });
    pointer(svg, "pointerdown", 1, 200, 200);
    pointer(svg, "pointermove", 1, 230, 240);
    await nextTick();
    expect(viewState(wrapper).centerX).toBeCloseTo(-8);
    expect(viewState(wrapper).centerY).toBeCloseTo(6);
  });

  it.each([
    [800, 800],
    [1200, 300],
  ])("anchors moving pinches in SVG coordinates in a %sx%s viewport", async (width, height) => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    installScreenTransform(svg, width, height);
    await zoomIn(3);
    const initial = viewState(wrapper);
    const scale = Math.min(width / initial.width, height / initial.height);
    const centerX = 30 + width / 2;
    const centerY = 50 + height / 2;
    // Start away from the center of the viewBox, then double the distance
    // while translating the midpoint 30px right and 40px down.
    const midpoint = { x: centerX + 20, y: centerY + 20 };
    pointer(svg, "pointerdown", 1, midpoint.x - 50, midpoint.y);
    pointer(svg, "pointerdown", 2, midpoint.x + 50, midpoint.y);
    pointer(svg, "pointermove", 1, midpoint.x - 70, midpoint.y + 40);
    await nextTick();
    pointer(svg, "pointermove", 2, midpoint.x + 130, midpoint.y + 40);
    await nextTick();

    expect(viewState(wrapper).zoom).toBeCloseTo(initial.zoom * 2);
    expect(viewState(wrapper).centerX).toBeCloseTo((20 - 50 / 2) / scale);
    expect(viewState(wrapper).centerY).toBeCloseTo((20 - 60 / 2) / scale);

    pointer(svg, "pointerup", 2, midpoint.x + 130, midpoint.y + 40);
    const afterPinch = viewState(wrapper);
    pointer(svg, "pointermove", 1, midpoint.x - 50, midpoint.y + 60);
    await nextTick();
    expect(viewState(wrapper).centerX).toBeCloseTo(afterPinch.centerX - 20 / (scale * 2));
    expect(viewState(wrapper).centerY).toBeCloseTo(afterPinch.centerY - 20 / (scale * 2));
    pointer(svg, "pointerup", 1, midpoint.x - 50, midpoint.y + 60);
  });

  it("handles consecutive pinch moves before the viewBox is rendered", async () => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    installScreenTransform(svg);
    await zoomIn(3);
    const initial = viewState(wrapper);
    const scale = 800 / initial.width;
    pointer(svg, "pointerdown", 1, 380, 450);
    pointer(svg, "pointerdown", 2, 480, 450);
    pointer(svg, "pointermove", 1, 350, 490);
    pointer(svg, "pointermove", 2, 550, 490);
    await nextTick();
    expect(viewState(wrapper).zoom).toBeCloseTo(initial.zoom * 2);
    expect(viewState(wrapper).centerX).toBeCloseTo(-20 / (scale * 2));
    expect(viewState(wrapper).centerY).toBeCloseTo(-40 / (scale * 2));
  });

  it("clamps zoom and pan to the world bounds", async () => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    installScreenTransform(svg);
    await zoomIn(20);
    expect(viewState(wrapper).zoom).toBe(64);
    expect(wrapper.get('button[aria-label="Zoom in"]').attributes("disabled")).toBeDefined();
    pointer(svg, "pointerdown", 1, 400, 400);
    pointer(svg, "pointermove", 1, -100_000, -100_000);
    await nextTick();
    const view = viewState(wrapper);
    expect(view.x + view.width).toBeCloseTo(180);
    expect(view.y + view.height).toBeCloseTo(90);
    pointer(svg, "pointerup", 1, -100_000, -100_000);
    await wrapper.get(".zoom-reset").trigger("click");
    expect(wrapper.get("svg").attributes("viewBox")).toBe("-180 -90 360 180");
    expect(wrapper.get('button[aria-label="Zoom out"]').attributes("disabled")).toBeDefined();
  });

  it("keeps a wheel focal point anchored through letterboxing", async () => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    installScreenTransform(svg);
    await zoomIn(3);
    const initial = viewState(wrapper);
    const scale = 800 / initial.width;
    svg.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: 470,
        clientY: 500,
        deltaY: -1,
      }),
    );
    await nextTick();
    expect(viewState(wrapper).zoom).toBeCloseTo(initial.zoom * 1.35);
    expect(viewState(wrapper).centerX).toBeCloseTo((40 / scale) * (1 - 1 / 1.35));
    expect(viewState(wrapper).centerY).toBeCloseTo((50 / scale) * (1 - 1 / 1.35));
  });

  it("suppresses only the click following a drag and preserves ordinary guesses", async () => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    installScreenTransform(svg);
    const country = wrapper.get("path.country");
    const setPointerCapture = vi.fn<(pointerId: number) => void>();
    const releasePointerCapture = vi.fn<(pointerId: number) => void>();
    Object.defineProperties(country.element, {
      setPointerCapture: { value: setPointerCapture },
      releasePointerCapture: { value: releasePointerCapture },
    });
    await zoomIn(3);
    pointer(country.element, "pointerdown", 1, 300, 300, "mouse");
    pointer(svg, "pointermove", 1, 320, 320, "mouse");
    pointer(country.element, "pointerup", 1, 320, 320, "mouse");
    await country.trigger("click");
    expect(wrapper.emitted("countryGuess")).toBeUndefined();
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);

    pointer(country.element, "pointerdown", 2, 300, 300, "mouse");
    pointer(country.element, "pointerup", 2, 300, 300, "mouse");
    await country.trigger("click");
    expect(wrapper.emitted("countryGuess")).toEqual([[countries[0]]]);
  });

  it("ignores secondary mouse buttons and ends cancelled or lost captures", async () => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    const { setPointerCapture } = installScreenTransform(svg);
    await zoomIn(3);
    const initial = viewState(wrapper);
    pointer(svg, "pointerdown", 1, 300, 300, "mouse", 2);
    pointer(svg, "pointermove", 1, 340, 340, "mouse", 2);
    await nextTick();
    expect(viewState(wrapper)).toEqual(initial);
    expect(setPointerCapture).not.toHaveBeenCalled();

    pointer(svg, "pointerdown", 2, 300, 300);
    pointer(svg, "pointercancel", 2, 300, 300);
    pointer(svg, "pointermove", 2, 340, 340);
    pointer(svg, "pointerdown", 3, 300, 300);
    pointer(svg, "lostpointercapture", 3, 300, 300);
    pointer(svg, "pointermove", 3, 340, 340);
    await nextTick();
    expect(viewState(wrapper)).toEqual(initial);
    expect(wrapper.get("svg").classes()).not.toContain("world-map--panning");
  });

  it("releases active captures and click suppression timers on unmount", async () => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    const { releasePointerCapture } = installScreenTransform(svg);
    pointer(svg, "pointerdown", 1, 300, 300);
    pointer(svg, "pointermove", 1, 330, 330);
    pointer(svg, "pointerup", 1, 330, 330);
    pointer(svg, "pointerdown", 2, 300, 300);
    wrapper.unmount();
    expect(releasePointerCapture).toHaveBeenCalledWith(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes keyboard-focused countries visible while zoomed, without animation", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const animationFrame = vi.spyOn(window, "requestAnimationFrame");
    await zoomIn(10);
    const paths = wrapper.findAll<SVGPathElement>("path.country");
    paths[0]?.element.focus();
    await nextTick();
    expect(viewState(wrapper).centerX).toBeCloseTo(-145);
    expect(document.activeElement).toBe(paths[0]?.element);

    await paths[0]?.trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    expect(document.activeElement).toBe(paths[1]?.element);
    expect(viewState(wrapper).centerX).toBeCloseTo(145);
    expect(paths.map((path) => path.attributes("tabindex"))).toEqual(["-1", "0", "-1"]);

    await paths[1]?.trigger("keydown", { key: "End" });
    await nextTick();
    const view = viewState(wrapper);
    expect(document.activeElement).toBe(paths[2]?.element);
    expect(view.x).toBeLessThan(-40);
    expect(view.x + view.width).toBeGreaterThan(40);
    expect(view.y).toBeLessThan(-35);
    expect(view.y + view.height).toBeGreaterThan(35);
    expect(animationFrame).not.toHaveBeenCalled();
    expect(wrapper.get("svg").attributes("role")).toBe("group");
  });

  it("does not pan for pointer focus and blocks keyboard/click guesses while disabled", async () => {
    const svg = wrapper.get<SVGSVGElement>("svg").element;
    installScreenTransform(svg);
    await zoomIn(6);
    const initial = viewState(wrapper);
    const country = wrapper.get<SVGPathElement>("path.country");
    pointer(svg, "pointerdown", 1, 300, 300, "mouse");
    country.element.focus();
    await nextTick();
    expect(viewState(wrapper)).toEqual(initial);
    pointer(svg, "pointerup", 1, 300, 300, "mouse");

    await country.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("countryGuess")).toEqual([[countries[0]]]);
    await wrapper.setProps({ guessingDisabled: true });
    await country.trigger("keydown", { key: " " });
    await country.trigger("click");
    expect(wrapper.emitted("countryGuess")).toHaveLength(1);
    expect(
      wrapper.findAll("path.country").every((path) => path.attributes("tabindex") === "-1"),
    ).toBe(true);
  });
});
