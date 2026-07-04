/**
 * Map viewport state: zoom / pan / pinch with pointer capture. Logic moved
 * verbatim from the original WorldMap component.
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
  zoom: number;
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
  const panStartScale = ref<MapPoint>({ x: 1, y: 1 });
  const isPinchingMap = ref(false);
  const pinchStart = ref<PinchGestureStart | null>(null);
  const hasDraggedMap = ref(false);
  const suppressNextCountryClick = ref(false);
  const activeMapPointers = new Map<number, MapPoint>();
  const pointerCaptureElements = new Map<number, Element>();

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

  const getSvgPointFromClient = (clientPoint: MapPoint) => {
    const svg = mapSvg.value;

    if (!svg) {
      return null;
    }

    const transformMatrix = svg.getScreenCTM();

    if (!transformMatrix) {
      return null;
    }

    const point = svg.createSVGPoint();
    point.x = clientPoint.x;
    point.y = clientPoint.y;

    const transformedPoint = point.matrixTransform(transformMatrix.inverse());

    return {
      x: transformedPoint.x,
      y: transformedPoint.y,
    };
  };

  const getSvgPoint = (event: PointerEvent | WheelEvent) =>
    getSvgPointFromClient({ x: event.clientX, y: event.clientY });

  const getClientPointRatio = (clientPoint: MapPoint) => {
    const svg = mapSvg.value;

    if (!svg) {
      return null;
    }

    const bounds = svg.getBoundingClientRect();

    if (!bounds.width || !bounds.height) {
      return null;
    }

    return {
      x: clamp((clientPoint.x - bounds.left) / bounds.width, 0, 1),
      y: clamp((clientPoint.y - bounds.top) / bounds.height, 0, 1),
    };
  };

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
    focalPoint: MapPoint,
    clientPoint: MapPoint,
  ) => {
    const clampedZoom = clamp(nextZoom, minimumMapZoom, maximumMapZoom);
    const clientRatio = getClientPointRatio(clientPoint);

    if (!clientRatio) {
      setZoom(clampedZoom, focalPoint);
      return;
    }

    const nextSize = getViewBoxSize(clampedZoom);

    zoomLevel.value = clampedZoom;
    mapCenter.value = getClampedCenter(
      {
        x: focalPoint.x + (0.5 - clientRatio.x) * nextSize.width,
        y: focalPoint.y + (0.5 - clientRatio.y) * nextSize.height,
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

  const releaseMapPointer = (event: PointerEvent) => {
    const captureTarget = pointerCaptureElements.get(event.pointerId);

    try {
      captureTarget?.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    } finally {
      pointerCaptureElements.delete(event.pointerId);
    }
  };

  const startPanningFromPoint = (clientPoint: MapPoint, preserveDragState = false) => {
    const svg = mapSvg.value;

    if (!svg) {
      return;
    }

    const bounds = svg.getBoundingClientRect();

    if (!bounds.width || !bounds.height) {
      return;
    }

    const { width, height } = getViewBoxSize(zoomLevel.value);

    isPanning.value = true;
    isPinchingMap.value = false;
    pinchStart.value = null;

    if (!preserveDragState) {
      hasDraggedMap.value = false;
    }

    panStartClient.value = { ...clientPoint };
    panStartCenter.value = { ...mapCenter.value };
    panStartScale.value = {
      x: width / bounds.width,
      y: height / bounds.height,
    };
  };

  const beginPinchGesture = () => {
    const pointerPair = getActiveMapPointerPair();

    if (!pointerPair) {
      return;
    }

    const [firstPointer, secondPointer] = pointerPair;
    const centerClient = getPointerMidpoint(firstPointer, secondPointer);
    const focalPoint = getSvgPointFromClient(centerClient);

    if (!focalPoint) {
      return;
    }

    isPanning.value = false;
    isPinchingMap.value = true;
    hasDraggedMap.value = true;
    panStartClient.value = null;
    pinchStart.value = {
      distance: Math.max(getPointerDistance(firstPointer, secondPointer), 1),
      zoom: zoomLevel.value,
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
      gesture.zoom * (currentDistance / gesture.distance),
      gesture.focalPoint,
      currentCenter,
    );
  };

  const suppressCountryClickAfterMapGesture = () => {
    suppressNextCountryClick.value = true;
    window.setTimeout(() => {
      suppressNextCountryClick.value = false;
    }, 0);
  };

  const stopMapInteraction = () => {
    if (hasDraggedMap.value) {
      suppressCountryClickAfterMapGesture();
    }

    isPanning.value = false;
    isPinchingMap.value = false;
    panStartClient.value = null;
    pinchStart.value = null;
    activeMapPointers.clear();
    pointerCaptureElements.clear();
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

    if (!isPanning.value || !panStartClient.value) {
      return;
    }

    const deltaX = event.clientX - panStartClient.value.x;
    const deltaY = event.clientY - panStartClient.value.y;

    if (Math.hypot(deltaX, deltaY) > dragClickThreshold) {
      hasDraggedMap.value = true;
    }

    setMapCenter({
      x: panStartCenter.value.x - deltaX * panStartScale.value.x,
      y: panStartCenter.value.y - deltaY * panStartScale.value.y,
    });
  };

  const handleMapPointerEnd = (event: PointerEvent) => {
    activeMapPointers.delete(event.pointerId);
    releaseMapPointer(event);

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
    activeMapPointers.clear();
    pointerCaptureElements.clear();
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
