/**
 * Pure helpers to estimate the bounding box of an SVG path string without a
 * DOM. Paths produced by `scripts/build-country-paths.ts` only contain
 * absolute `M x,y x,y … Z` subpaths, so scanning coordinate pairs is exact.
 */
export interface MapPoint {
  x: number;
  y: number;
}

export interface CountryFocusBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

export const getPathSubpathBounds = (subpath: string): CountryFocusBounds | null => {
  const coordinateValues = subpath.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const points: MapPoint[] = [];
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < coordinateValues.length - 1; index += 2) {
    const x = Number(coordinateValues[index]);
    const y = Number(coordinateValues[index + 1]);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    points.push({ x, y });
    minimumX = Math.min(minimumX, x);
    maximumX = Math.max(maximumX, x);
    minimumY = Math.min(minimumY, y);
    maximumY = Math.max(maximumY, y);
  }

  if (points.length === 0) {
    return null;
  }

  const signedArea = points.reduce((totalArea, point, index) => {
    const nextPoint = points[(index + 1) % points.length] ?? point;

    return totalArea + point.x * nextPoint.y - nextPoint.x * point.y;
  }, 0);
  const width = maximumX - minimumX;
  const height = maximumY - minimumY;
  const polygonArea = Math.abs(signedArea) / 2;

  return {
    x: minimumX,
    y: minimumY,
    width,
    height,
    area: polygonArea > 0 ? polygonArea : width * height,
  } satisfies CountryFocusBounds;
};

/**
 * Return the bounds of the largest subpath (mainland) of a country path so
 * reveal animations can focus it.
 */
export const getLargestSubpathBounds = (path: string): CountryFocusBounds | null => {
  const subpathBounds = (path.match(/M[^M]*/g) ?? [])
    .map((subpath) => getPathSubpathBounds(subpath))
    .filter((bounds): bounds is CountryFocusBounds => bounds !== null)
    .sort((firstBounds, secondBounds) => {
      if (secondBounds.area !== firstBounds.area) {
        return secondBounds.area - firstBounds.area;
      }

      return secondBounds.width * secondBounds.height - firstBounds.width * firstBounds.height;
    });

  return subpathBounds[0] ?? null;
};
