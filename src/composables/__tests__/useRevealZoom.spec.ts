import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { shallowRef } from "vue";
import { countries } from "../../../public/countries.paths.json";
import { getLargestSubpathBounds } from "@/utils/svg-path-bounds";
import { maximumMapZoom, useMapViewport } from "../useMapViewport";
import { missedCountryRevealRoundDelayMilliseconds, useRevealZoom } from "../useRevealZoom";

const setup = () => {
  const viewport = useMapViewport();
  viewport.setMapViewState({ zoom: 3, center: { x: -50, y: -20 } });
  const original = viewport.getCurrentMapViewState();
  const reveal = useRevealZoom(
    viewport,
    shallowRef([{ id: "target", name: "Target", path: "M100,10 110,10 110,20 100,20Z" }]),
  );
  return { viewport, original, reveal };
};

describe("useRevealZoom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("animates the reveal and restores the viewport before the next round", () => {
    const { viewport, original, reveal } = setup();
    expect(reveal.playMissedCountryRevealZoom("target")).toBe(true);
    vi.advanceTimersByTime(1200);
    expect(viewport.mapCenter.value.x).toBeCloseTo(105);
    expect(viewport.mapCenter.value.y).toBeCloseTo(15);
    expect(viewport.zoomLevel.value).toBeGreaterThan(original.zoom);
    vi.advanceTimersByTime(missedCountryRevealRoundDelayMilliseconds - 1200);
    expect(viewport.getCurrentMapViewState()).toEqual(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a static reveal with reduced motion and then restores the view", () => {
    const matchMedia = vi.fn<(query: string) => Pick<MediaQueryList, "matches">>(() => ({
      matches: true,
    }));
    vi.stubGlobal("matchMedia", matchMedia);
    const animationFrame = vi.spyOn(window, "requestAnimationFrame");
    const { viewport, original, reveal } = setup();

    expect(reveal.playMissedCountryRevealZoom("target")).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    const target = viewport.getCurrentMapViewState();
    expect(target.center).toEqual({ x: 105, y: 15 });
    vi.advanceTimersByTime(2000);
    expect(viewport.getCurrentMapViewState()).toEqual(target);
    expect(animationFrame).not.toHaveBeenCalled();
    vi.advanceTimersByTime(missedCountryRevealRoundDelayMilliseconds - 2000);
    expect(viewport.getCurrentMapViewState()).toEqual(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "cancels and restores an abandoned reveal (reduced motion: %s)",
    (reduced) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: reduced })),
      );
      const { viewport, original, reveal } = setup();
      reveal.playMissedCountryRevealZoom("target");
      vi.advanceTimersByTime(1200);
      reveal.cancelRevealZoomAnimation(true);
      expect(viewport.getCurrentMapViewState()).toEqual(original);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(missedCountryRevealRoundDelayMilliseconds);
      expect(viewport.getCurrentMapViewState()).toEqual(original);
    },
  );

  it.each([false, true])(
    "does not undo manual interaction after cancellation (reduced motion: %s)",
    (reduced) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: reduced })),
      );
      const { viewport, reveal } = setup();
      reveal.playMissedCountryRevealZoom("target");
      vi.advanceTimersByTime(1200);
      reveal.cancelRevealZoomAnimation();
      viewport.setMapViewState({ zoom: 4, center: { x: 20, y: 10 } });
      const manualView = viewport.getCurrentMapViewState();
      vi.advanceTimersByTime(missedCountryRevealRoundDelayMilliseconds);
      reveal.cancelRevealZoomAnimation(true);
      expect(viewport.getCurrentMapViewState()).toEqual(manualView);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "fits Norway from zoom 64 and restores the original view (reduced motion: %s)",
    (reduced) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: reduced })),
      );
      const norway = countries.find((country) => country.name === "Norway")!;
      const bounds = getLargestSubpathBounds(norway.path)!;
      const viewport = useMapViewport();
      viewport.setMapViewState({ zoom: maximumMapZoom, center: { x: -50, y: -20 } });
      const original = viewport.getCurrentMapViewState();
      const reveal = useRevealZoom(viewport, shallowRef([norway]));

      expect(reveal.playMissedCountryRevealZoom(norway.id)).toBe(true);
      vi.advanceTimersByTime(1200);
      const target = viewport.getCurrentMapViewState();
      const size = viewport.getViewBoxSize(target.zoom);
      expect(target.zoom).toBeLessThan(original.zoom);
      expect(target.center.x).toBeCloseTo(bounds.x + bounds.width / 2);
      expect(target.center.y).toBeCloseTo(bounds.y + bounds.height / 2);
      expect(bounds.width / size.width).toBeLessThanOrEqual(0.62 + 1e-10);
      expect(bounds.height / size.height).toBeLessThanOrEqual(0.62 + 1e-10);
      expect(bounds.x).toBeGreaterThan(target.center.x - size.width / 2);
      expect(bounds.y).toBeGreaterThan(target.center.y - size.height / 2);
      expect(bounds.x + bounds.width).toBeLessThan(target.center.x + size.width / 2);
      expect(bounds.y + bounds.height).toBeLessThan(target.center.y + size.height / 2);

      vi.advanceTimersByTime(missedCountryRevealRoundDelayMilliseconds - 1200);
      expect(viewport.getCurrentMapViewState()).toEqual(original);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores countries with no focus bounds", () => {
    const { viewport, original, reveal } = setup();
    expect(reveal.playMissedCountryRevealZoom("missing")).toBe(false);
    expect(viewport.getCurrentMapViewState()).toEqual(original);
    expect(vi.getTimerCount()).toBe(0);
  });
});
