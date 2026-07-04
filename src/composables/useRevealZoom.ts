/**
 * Missed-country reveal animation: zoom out to the world view, zoom into the
 * missed country, hold, then restore the previous viewport. Logic moved
 * verbatim from the original WorldMap component.
 */
import type { Ref } from "vue";
import { clamp } from "@shared/game-utils";
import type { CountryPath } from "@/types/game";
import { getLargestSubpathBounds } from "@/utils/svg-path-bounds";
import type { MapPoint } from "@/utils/svg-path-bounds";
import { mapBounds, maximumMapZoom, minimumMapZoom } from "@/composables/useMapViewport";
import type { MapViewState, MapViewport } from "@/composables/useMapViewport";

const missedCountryRevealResetMilliseconds = 250;
const missedCountryRevealZoomInMilliseconds = 800;
const missedCountryRevealZoomHoldMilliseconds = 450;
const missedCountryRevealZoomOutMilliseconds = 900;
export const missedCountryRevealRoundDelayMilliseconds =
  missedCountryRevealResetMilliseconds +
  missedCountryRevealZoomInMilliseconds +
  missedCountryRevealZoomHoldMilliseconds +
  missedCountryRevealZoomOutMilliseconds +
  200;
const missedCountryRevealTargetFillRatio = 0.62;
const missedCountryRevealMinimumSpan = 0.75;
const missedCountryRevealZoomBoost = 1.15;

const easeInOutCubic = (progress: number) =>
  progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;

export const useRevealZoom = (viewport: MapViewport, countries: Ref<CountryPath[]>) => {
  const { getCurrentMapViewState, getDefaultMapViewState, getViewBoxSize, setMapViewState } =
    viewport;

  let revealZoomAnimationFrame: number | null = null;
  let revealZoomHoldTimeout: number | null = null;
  let revealZoomSequenceId = 0;
  let revealZoomRestoreState: MapViewState | null = null;

  const getCountryFocusBounds = (countryId: string) => {
    const country = countries.value.find((entry) => entry.id === countryId);

    if (!country) {
      return null;
    }

    return getLargestSubpathBounds(country.path);
  };

  const getMissedCountryRevealTarget = (
    countryId: string,
    restoreState: MapViewState,
  ): MapViewState | null => {
    const bounds = getCountryFocusBounds(countryId);

    if (!bounds) {
      return null;
    }

    const countryWidth = Math.max(bounds.width, missedCountryRevealMinimumSpan);
    const countryHeight = Math.max(bounds.height, missedCountryRevealMinimumSpan);
    const fittedZoom = Math.min(
      (mapBounds.width * missedCountryRevealTargetFillRatio) / countryWidth,
      (mapBounds.height * missedCountryRevealTargetFillRatio) / countryHeight,
    );
    const zoom = clamp(
      Math.max(fittedZoom, restoreState.zoom * missedCountryRevealZoomBoost),
      minimumMapZoom,
      maximumMapZoom,
    );
    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };

    return { zoom, center };
  };

  const clearRevealZoomAnimation = () => {
    if (revealZoomAnimationFrame !== null) {
      window.cancelAnimationFrame(revealZoomAnimationFrame);
      revealZoomAnimationFrame = null;
    }

    if (revealZoomHoldTimeout !== null) {
      window.clearTimeout(revealZoomHoldTimeout);
      revealZoomHoldTimeout = null;
    }
  };

  const cancelRevealZoomAnimation = (restorePreviousView = false) => {
    clearRevealZoomAnimation();
    revealZoomSequenceId += 1;

    if (restorePreviousView && revealZoomRestoreState) {
      setMapViewState(revealZoomRestoreState);
    }

    revealZoomRestoreState = null;
  };

  const animateMapView = (
    fromState: MapViewState,
    toState: MapViewState,
    duration: number,
    sequenceId: number,
    onComplete?: () => void,
    options: { clampCenter?: boolean } = {},
  ) => {
    const startTime = window.performance.now();

    const step = (timestamp: number) => {
      if (sequenceId !== revealZoomSequenceId) {
        return;
      }

      const progress = clamp((timestamp - startTime) / duration, 0, 1);
      const easedProgress = easeInOutCubic(progress);

      setMapViewState(
        {
          zoom: fromState.zoom + (toState.zoom - fromState.zoom) * easedProgress,
          center: {
            x: fromState.center.x + (toState.center.x - fromState.center.x) * easedProgress,
            y: fromState.center.y + (toState.center.y - fromState.center.y) * easedProgress,
          },
        },
        options,
      );

      if (progress < 1) {
        revealZoomAnimationFrame = window.requestAnimationFrame(step);
        return;
      }

      revealZoomAnimationFrame = null;
      setMapViewState(toState, options);
      onComplete?.();
    };

    revealZoomAnimationFrame = window.requestAnimationFrame(step);
  };

  const getMapPointViewRatio = (point: MapPoint, state: MapViewState) => {
    const { width, height } = getViewBoxSize(state.zoom);

    return {
      x: (point.x - (state.center.x - width / 2)) / width,
      y: (point.y - (state.center.y - height / 2)) / height,
    };
  };

  const getMapViewStateForPointRatio = (
    point: MapPoint,
    zoom: number,
    ratio: MapPoint,
  ): MapViewState => {
    const { width, height } = getViewBoxSize(zoom);

    return {
      zoom,
      center: {
        x: point.x + (0.5 - ratio.x) * width,
        y: point.y + (0.5 - ratio.y) * height,
      },
    };
  };

  const animateMapZoomAroundPoint = (
    fromState: MapViewState,
    toState: MapViewState,
    focalPoint: MapPoint,
    duration: number,
    sequenceId: number,
    onComplete?: () => void,
  ) => {
    const startTime = window.performance.now();
    const fromRatio = getMapPointViewRatio(focalPoint, fromState);
    const toRatio = getMapPointViewRatio(focalPoint, toState);

    const step = (timestamp: number) => {
      if (sequenceId !== revealZoomSequenceId) {
        return;
      }

      const progress = clamp((timestamp - startTime) / duration, 0, 1);
      const easedProgress = easeInOutCubic(progress);
      const zoom = fromState.zoom + (toState.zoom - fromState.zoom) * easedProgress;
      const ratio = {
        x: fromRatio.x + (toRatio.x - fromRatio.x) * easedProgress,
        y: fromRatio.y + (toRatio.y - fromRatio.y) * easedProgress,
      };

      setMapViewState(getMapViewStateForPointRatio(focalPoint, zoom, ratio), {
        clampCenter: false,
      });

      if (progress < 1) {
        revealZoomAnimationFrame = window.requestAnimationFrame(step);
        return;
      }

      revealZoomAnimationFrame = null;
      setMapViewState(toState, { clampCenter: false });
      onComplete?.();
    };

    revealZoomAnimationFrame = window.requestAnimationFrame(step);
  };

  const playMissedCountryRevealZoom = (countryId: string) => {
    const restoreState = getCurrentMapViewState();
    const defaultState = getDefaultMapViewState();
    const targetState = getMissedCountryRevealTarget(countryId, restoreState);

    if (!targetState) {
      return false;
    }

    clearRevealZoomAnimation();
    const sequenceId = (revealZoomSequenceId += 1);
    revealZoomRestoreState = restoreState;

    const restoreOriginalView = () => {
      if (sequenceId !== revealZoomSequenceId) {
        return;
      }

      animateMapView(
        getCurrentMapViewState(),
        restoreState,
        missedCountryRevealZoomOutMilliseconds,
        sequenceId,
        () => {
          if (sequenceId === revealZoomSequenceId) {
            setMapViewState(restoreState);
            revealZoomRestoreState = null;
          }
        },
        { clampCenter: false },
      );
    };

    const holdOnCountry = () => {
      if (sequenceId !== revealZoomSequenceId) {
        return;
      }

      revealZoomHoldTimeout = window.setTimeout(() => {
        revealZoomHoldTimeout = null;
        restoreOriginalView();
      }, missedCountryRevealZoomHoldMilliseconds);
    };

    const zoomIntoCenteredCountry = () => {
      if (sequenceId !== revealZoomSequenceId) {
        return;
      }

      animateMapZoomAroundPoint(
        getCurrentMapViewState(),
        targetState,
        targetState.center,
        missedCountryRevealZoomInMilliseconds,
        sequenceId,
        holdOnCountry,
      );
    };

    animateMapView(
      restoreState,
      defaultState,
      missedCountryRevealResetMilliseconds,
      sequenceId,
      zoomIntoCenteredCountry,
    );

    return true;
  };

  return {
    cancelRevealZoomAnimation,
    playMissedCountryRevealZoom,
  };
};
