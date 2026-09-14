/**
 * Map viewport state: zoom / pan / pinch with pointer capture. All client
 * coordinates use the inverse SVG screen transform, including letterboxing.
 */
import { computed, ref } from "vue";
import { clamp } from "@shared/game-utils";
import type { MapPoint } from "@/utils/svg-path-bounds";

export interface MapViewState {
  zoom: number;
  center: MapPoint;
}

interface PinchGestureStart {
  distance: number;
  viewState: MapViewState;
  transform: DOMMatrix;
  focalPoint: MapPoint;
  centerClient: MapPoint;
}

export const mapBounds = {
  x: -180,
  y: -90,
  width: 360,
  height: 180,
};
export const minimumMapZoom = 1;
export const maximumMapZoom = 64;
const zoomStep = 1.35;
const dragClickThreshold = 4;

export interface MapViewportOptions {
  /** Called before any user-driven viewport change (wheel, pointer, zoom buttons). */
  onBeforeInteraction?: () => void;
}

export const useMapViewport = (options: MapViewportOptions = {}) => {
  const mapSvg = ref<SVGSVGElement | null>(null);
  const zoomLevel = ref(1);
  const mapCenter = ref<MapPoint>({ x: 0, y: 0 });
  const isPanning = ref(false);
  const panStartClient = ref<MapPoint | null>(null);
  const panStartCenter = ref<MapPoint>({ x: 0, y: 0 });
  let panStartTransform: DOMMatrix | null = null;
  const isPinchingMap = ref(false);
  const pinchStart = ref<PinchGestureStart | null>(null);
  const hasDraggedMap = ref(false);
  const suppressNextCountryClick = ref(false);
  const activeMapPointers = new Map<number, MapPoint>();
  const pointerCaptureElements = new Map<number, Element>();
  let suppressCountryClickTimeout: number | null = null;

  const beforeInteraction = () => {
    options.onBeforeInteraction?.();
  };

  const mapViewBox = computed(() => {
    const width = mapBounds.width / zoomLevel.value;
    const height = mapBounds.height / zoomLevel.value;
    const x = mapCenter.value.x - width / 2;
    const y = mapCenter.value.y - height / 2;

    return `${x} ${y} ${width} ${height}`;
  });

  const zoomPercent = computed(() => `${Math.round(zoomLevel.value * 100)}%`);
  const canZoomIn = computed(() => zoomLevel.value < maximumMapZoom);
  const canZoomOut = computed(() => zoomLevel.value > minimumMapZoom);

  const getViewBoxSize = (zoom: number) => ({
    width: mapBounds.width / zoom,
    height: mapBounds.height / zoom,
  });

  const getClampedCenter = (center: MapPoint, zoom: number) => {
    const { width, height } = getViewBoxSize(zoom);
    const minimumX = mapBounds.x + width / 2;
    const maximumX = mapBounds.x + mapBounds.width - width / 2;
    const minimumY = mapBounds.y + height / 2;
    const maximumY = mapBounds.y + mapBounds.height - height / 2;

    return {
      x: clamp(center.x, minimumX, maximumX),
      y: clamp(center.y, minimumY, maximumY),
    };
  };

  const setMapCenter = (center: MapPoint) => {
    mapCenter.value = getClampedCenter(center, zoomLevel.value);
  };

  const getCurrentMapViewState = (): MapViewState => ({
    zoom: zoomLevel.value,
    center: { ...mapCenter.value },
  });

  const getDefaultMapViewState = (): MapViewState => ({
    zoom: minimumMapZoom,
    center: { x: 0, y: 0 },
  });

  const setMapViewState = (state: MapViewState, options: { clampCenter?: boolean } = {}) => {
    const clampedZoom = clamp(state.zoom, minimumMapZoom, maximumMapZoom);

    zoomLevel.value = clampedZoom;
    mapCenter.value =
      options.clampCenter === false
        ? { ...state.center }
        : getClampedCenter(state.center, clampedZoom);
  };

  const getInverseScreenTransform = () => {
    try {
      const transform = mapSvg.value?.getScreenCTM()?.inverse();

      // Hidden/detached SVGs and singular CSS transforms have no usable CTM.
      return transform &&
        [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f].every(
          Number.isFinite,
        )
        ? transform
        : null;
    } catch {
      return null;
    }
  };

  const getSvgPointFromClient = (
    point: MapPoint,
    transform = getInverseScreenTransform(),
  ): MapPoint | null =>
    transform
      ? {
          x: transform.a * point.x + transform.c * point.y + transform.e,
          y: transform.b * point.x + transform.d * point.y + transform.f,
        }
      : null;

  const getSvgPoint = (event: PointerEvent | WheelEvent) =>
    getSvgPointFromClient({ x: event.clientX, y: event.clientY });

  const setZoom = (nextZoom: number, focalPoint?: MapPoint) => {
    const previousZoom = zoomLevel.value;
    const clampedZoom = clamp(nextZoom, minimumMapZoom, maximumMapZoom);

    if (clampedZoom === previousZoom) {
      return;
    }

    const previousSize = getViewBoxSize(previousZoom);
    const nextSize = getViewBoxSize(clampedZoom);
    let nextCenter = mapCenter.value;

    if (focalPoint) {
      const previousX = mapCenter.value.x - previousSize.width / 2;
      const previousY = mapCenter.value.y - previousSize.height / 2;
      const focalRatioX = (focalPoint.x - previousX) / previousSize.width;
      const focalRatioY = (focalPoint.y - previousY) / previousSize.height;

      nextCenter = {
        x: focalPoint.x + (0.5 - focalRatioX) * nextSize.width,
        y: focalPoint.y + (0.5 - focalRatioY) * nextSize.height,
      };
    }

    zoomLevel.value = clampedZoom;
    mapCenter.value = getClampedCenter(nextCenter, clampedZoom);
  };

  const setZoomFromClientAnchor = (
    nextZoom: number,
    gesture: PinchGestureStart,
    clientPoint: MapPoint,
  ) => {
    const clampedZoom = clamp(nextZoom, minimumMapZoom, maximumMapZoom);
    const point = getSvgPointFromClient(clientPoint, gesture.transform);

    if (!point) {
      return;
    }

    // Keep the original focal point under the moving midpoint. Use a frozen
    // transform/view pair so moves also work before Vue updates the viewBox.
    // Bounding-rectangle ratios are wrong with xMidYMid meet letterboxing.
    const scale = gesture.viewState.zoom / clampedZoom;

    zoomLevel.value = clampedZoom;
    mapCenter.value = getClampedCenter(
      {
        x: gesture.focalPoint.x - (point.x - gesture.viewState.center.x) * scale,
        y: gesture.focalPoint.y - (point.y - gesture.viewState.center.y) * scale,
      },
      clampedZoom,
    );
  };

  const zoomIn = () => {
    beforeInteraction();
    setZoom(zoomLevel.value * zoomStep);
  };

  const zoomOut = () => {
    beforeInteraction();
    setZoom(zoomLevel.value / zoomStep);
  };

  const resetZoom = () => {
    beforeInteraction();
    setMapViewState(getDefaultMapViewState());
  };

  const handleMapWheel = (event: WheelEvent) => {
    beforeInteraction();
    const focalPoint = getSvgPoint(event);
    const zoomFactor = event.deltaY < 0 ? zoomStep : 1 / zoomStep;

    setZoom(zoomLevel.value * zoomFactor, focalPoint ?? undefined);
  };

  const getPointerDistance = (firstPointer: MapPoint, secondPointer: MapPoint) =>
    Math.hypot(firstPointer.x - secondPointer.x, firstPointer.y - secondPointer.y);

  const getPointerMidpoint = (firstPointer: MapPoint, secondPointer: MapPoint) => ({
    x: (firstPointer.x + secondPointer.x) / 2,
    y: (firstPointer.y + secondPointer.y) / 2,
  });

  const getActiveMapPointerPair = (): [MapPoint, MapPoint] | null => {
    const [firstPointer, secondPointer] = Array.from(activeMapPointers.values());

    if (!firstPointer || !secondPointer) {
      return null;
    }

    return [firstPointer, secondPointer];
  };

  const captureMapPointer = (event: PointerEvent) => {
    const captureTarget = event.target instanceof Element ? event.target : mapSvg.value;

    if (!captureTarget) {
      return;
    }

    try {
      captureTarget.setPointerCapture(event.pointerId);
      pointerCaptureElements.set(event.pointerId, captureTarget);
    } catch {
      // Some browsers can throw if capture is requested after cancellation.
    }
  };

  const releaseMapPointer = (pointerId: number) => {
    const captureTarget = pointerCaptureElements.get(pointerId);
    pointerCaptureElements.delete(pointerId);

    try {
      captureTarget?.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };

  const startPanningFromPoint = (clientPoint: MapPoint, preserveDragState = false) => {
    const transform = getInverseScreenTransform();

    if (!transform) {
      return;
    }

    isPanning.value = true;
    isPinchingMap.value = false;
    pinchStart.value = null;

    if (!preserveDragState) {
      hasDraggedMap.value = false;
    }

    panStartClient.value = { ...clientPoint };
    panStartCenter.value = { ...mapCenter.value };
    panStartTransform = transform;
  };

  const beginPinchGesture = () => {
    const pointerPair = getActiveMapPointerPair();

    if (!pointerPair) {
      return;
    }

    const [firstPointer, secondPointer] = pointerPair;
    const centerClient = getPointerMidpoint(firstPointer, secondPointer);
    const transform = getInverseScreenTransform();
    const focalPoint = getSvgPointFromClient(centerClient, transform);

    if (!focalPoint || !transform) {
      return;
    }

    isPanning.value = false;
    isPinchingMap.value = true;
    hasDraggedMap.value = true;
    panStartClient.value = null;
    pinchStart.value = {
      distance: Math.max(getPointerDistance(firstPointer, secondPointer), 1),
      viewState: getCurrentMapViewState(),
      transform,
      focalPoint,
      centerClient,
    };
  };

  const updatePinchGesture = () => {
    const gesture = pinchStart.value;
    const pointerPair = getActiveMapPointerPair();

    if (!gesture || !pointerPair) {
      return;
    }

    const [firstPointer, secondPointer] = pointerPair;
    const currentDistance = Math.max(getPointerDistance(firstPointer, secondPointer), 1);
    const currentCenter = getPointerMidpoint(firstPointer, secondPointer);
    const centerDelta = getPointerDistance(currentCenter, gesture.centerClient);

    if (
      Math.abs(currentDistance - gesture.distance) > dragClickThreshold ||
      centerDelta > dragClickThreshold
    ) {
      hasDraggedMap.value = true;
    }

    setZoomFromClientAnchor(
      gesture.viewState.zoom * (currentDistance / gesture.distance),
      gesture,
      currentCenter,
    );
  };

  const suppressCountryClickAfterMapGesture = () => {
    suppressNextCountryClick.value = true;
    if (suppressCountryClickTimeout !== null) {
      window.clearTimeout(suppressCountryClickTimeout);
    }
    suppressCountryClickTimeout = window.setTimeout(() => {
      suppressCountryClickTimeout = null;
      suppressNextCountryClick.value = false;
    }, 0);
  };

  const stopMapInteraction = (suppressClick = true) => {
    if (suppressClick && hasDraggedMap.value) {
      suppressCountryClickAfterMapGesture();
    }

    isPanning.value = false;
    isPinchingMap.value = false;
    panStartClient.value = null;
    panStartTransform = null;
    pinchStart.value = null;
    hasDraggedMap.value = false;
    activeMapPointers.clear();
    for (const pointerId of pointerCaptureElements.keys()) {
      releaseMapPointer(pointerId);
    }
  };

  const handleMapPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    beforeInteraction();

    const svg = mapSvg.value;

    if (!svg) {
      return;
    }

    const clientPoint = { x: event.clientX, y: event.clientY };

    captureMapPointer(event);
    activeMapPointers.set(event.pointerId, clientPoint);

    if (activeMapPointers.size >= 2) {
      beginPinchGesture();
      return;
    }

    startPanningFromPoint(clientPoint);
  };

  const handleMapPointerMove = (event: PointerEvent) => {
    if (!activeMapPointers.has(event.pointerId)) {
      return;
    }

    const clientPoint = { x: event.clientX, y: event.clientY };

    activeMapPointers.set(event.pointerId, clientPoint);

    if (activeMapPointers.size >= 2) {
      if (!isPinchingMap.value) {
        beginPinchGesture();
      }

      updatePinchGesture();
      return;
    }

    if (!isPanning.value || !panStartClient.value || !panStartTransform) {
      return;
    }

    const deltaX = event.clientX - panStartClient.value.x;
    const deltaY = event.clientY - panStartClient.value.y;

    if (Math.hypot(deltaX, deltaY) > dragClickThreshold) {
      hasDraggedMap.value = true;
    }

    setMapCenter({
      x: panStartCenter.value.x - (panStartTransform.a * deltaX + panStartTransform.c * deltaY),
      y: panStartCenter.value.y - (panStartTransform.b * deltaX + panStartTransform.d * deltaY),
    });
  };

  const handleMapPointerEnd = (event: PointerEvent) => {
    if (!activeMapPointers.has(event.pointerId)) {
      return;
    }

    activeMapPointers.delete(event.pointerId);
    releaseMapPointer(event.pointerId);

    if (isPinchingMap.value && activeMapPointers.size >= 2) {
      beginPinchGesture();
      return;
    }

    if (isPinchingMap.value && activeMapPointers.size === 1) {
      const [remainingPointer] = Array.from(activeMapPointers.values());

      if (remainingPointer) {
        startPanningFromPoint(remainingPointer, true);
        return;
      }
    }

    if (activeMapPointers.size === 0) {
      stopMapInteraction();
    }
  };

  /**
   * Returns true (and consumes the flag) when the click that follows a map
   * drag/pinch gesture should be ignored instead of counted as a guess.
   */
  const consumeSuppressedClick = () => {
    if (suppressNextCountryClick.value) {
      suppressNextCountryClick.value = false;
      return true;
    }

    return false;
  };

  const teardown = () => {
    stopMapInteraction(false);
    if (suppressCountryClickTimeout !== null) {
      window.clearTimeout(suppressCountryClickTimeout);
      suppressCountryClickTimeout = null;
    }
    suppressNextCountryClick.value = false;
  };

  return {
    mapSvg,
    zoomLevel,
    mapCenter,
    mapViewBox,
    zoomPercent,
    canZoomIn,
    canZoomOut,
    isPanning,
    isPinchingMap,
    getViewBoxSize,
    getCurrentMapViewState,
    getDefaultMapViewState,
    setMapViewState,
    zoomIn,
    zoomOut,
    resetZoom,
    handleMapWheel,
    handleMapPointerDown,
    handleMapPointerMove,
    handleMapPointerEnd,
    consumeSuppressedClick,
    teardown,
  };
};

export type MapViewport = ReturnType<typeof useMapViewport>;
