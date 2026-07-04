#!/usr/bin/env node
/**
 * Converts `data/countries.geo.json` into the compact SVG path payload at
 * `public/countries.paths.json`.
 *
 * Shared borders are simplified as shared arcs (a light-weight topology pass)
 * so neighbouring countries stay crack-free after simplification. The core
 * is exported as `buildCountryPaths` for unit testing; the CLI entry point
 * reads env knobs and files.
 *
 * Env knobs: COUNTRY_MAP_TOLERANCE, COUNTRY_MAP_MIN_AREA,
 * COUNTRY_MAP_MAX_RINGS_PER_COUNTRY, COUNTRY_MAP_DECIMALS.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

type Point = [number, number];

interface GeoJsonGeometry {
  type?: string;
  coordinates?: unknown[];
}

interface GeoJsonFeature {
  id?: string | number | null;
  properties?: { name?: unknown } | null;
  geometry?: GeoJsonGeometry | null;
}

interface GeoJsonFeatureCollection {
  features?: GeoJsonFeature[];
}

export interface BuildOptions {
  simplificationTolerance: number;
  minimumRingArea: number;
  maximumRingsPerCountry: number;
  coordinateDecimals: number;
}

export interface BuildStats {
  sourceRingCount: number;
  keptRingCount: number;
  sourcePointCount: number;
  keptSourcePointCount: number;
  outputPointCount: number;
}

export interface CountryPathEntry {
  id: string;
  name: string;
  path: string;
}

export interface BuildResult {
  countries: CountryPathEntry[];
  stats: BuildStats;
}

interface RingInfo {
  points: Point[];
  area: number;
  featureIndex: number;
  ringIndex: number;
  keys: string[];
}

interface Topology {
  edgeUseCounts: Map<string, number>;
  adjacency: Map<string, Set<string>>;
}

export const defaultBuildOptions: BuildOptions = {
  simplificationTolerance: 0.08,
  minimumRingArea: 0.02,
  maximumRingsPerCountry: 20,
  coordinateDecimals: 3,
};

const getSquaredDistance = (first: Point, second: Point) => {
  const deltaX = first[0] - second[0];
  const deltaY = first[1] - second[1];

  return deltaX * deltaX + deltaY * deltaY;
};

const getSquaredSegmentDistance = (point: Point, first: Point, second: Point) => {
  let x = first[0];
  let y = first[1];
  let deltaX = second[0] - x;
  let deltaY = second[1] - y;

  if (deltaX !== 0 || deltaY !== 0) {
    const progress =
      ((point[0] - x) * deltaX + (point[1] - y) * deltaY) / (deltaX * deltaX + deltaY * deltaY);

    if (progress > 1) {
      x = second[0];
      y = second[1];
    } else if (progress > 0) {
      x += deltaX * progress;
      y += deltaY * progress;
    }
  }

  deltaX = point[0] - x;
  deltaY = point[1] - y;

  return deltaX * deltaX + deltaY * deltaY;
};

const toPoint = (coordinate: unknown): Point | null => {
  if (!Array.isArray(coordinate)) {
    return null;
  }

  const longitude = Number(coordinate[0]);
  const latitude = Number(coordinate[1]);

  return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null;
};

const pointsMatch = (first: Point, second: Point) =>
  first[0] === second[0] && first[1] === second[1];

const removeClosingPoint = (points: Point[]) => {
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  if (points.length > 1 && firstPoint && lastPoint && pointsMatch(firstPoint, lastPoint)) {
    return points.slice(0, -1);
  }

  return points;
};

const getRingArea = (points: Point[]) => {
  let area = 0;

  for (
    let index = 0, previousIndex = points.length - 1;
    index < points.length;
    previousIndex = index, index += 1
  ) {
    const [previousX, previousY] = points[previousIndex] as Point;
    const [x, y] = points[index] as Point;

    area += previousX * y - x * previousY;
  }

  return Math.abs(area) / 2;
};

const pointKey = (point: Point) => `${point[0]},${point[1]}`;

const edgeKey = (firstKey: string, secondKey: string) =>
  firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;

const addAdjacentPoint = (
  adjacency: Map<string, Set<string>>,
  firstKey: string,
  secondKey: string,
) => {
  const adjacentPoints = adjacency.get(firstKey) ?? new Set<string>();

  adjacentPoints.add(secondKey);
  adjacency.set(firstKey, adjacentPoints);
};

const buildTopology = (rings: RingInfo[]): Topology => {
  const edgeUseCounts = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();

  for (const ring of rings) {
    for (let index = 0; index < ring.keys.length; index += 1) {
      const firstKey = ring.keys[index] as string;
      const secondKey = ring.keys[(index + 1) % ring.keys.length] as string;
      const key = edgeKey(firstKey, secondKey);

      edgeUseCounts.set(key, (edgeUseCounts.get(key) ?? 0) + 1);
      addAdjacentPoint(adjacency, firstKey, secondKey);
      addAdjacentPoint(adjacency, secondKey, firstKey);
    }
  }

  return { edgeUseCounts, adjacency };
};

const isJunctionPoint = (ring: RingInfo, index: number, topology: Topology) => {
  const currentKey = ring.keys[index] as string;
  const previousKey = ring.keys[(index - 1 + ring.keys.length) % ring.keys.length] as string;
  const nextKey = ring.keys[(index + 1) % ring.keys.length] as string;
  const previousEdgeUseCount = topology.edgeUseCounts.get(edgeKey(previousKey, currentKey)) ?? 0;
  const nextEdgeUseCount = topology.edgeUseCounts.get(edgeKey(currentKey, nextKey)) ?? 0;
  const adjacentPointCount = topology.adjacency.get(currentKey)?.size ?? 0;

  return adjacentPointCount !== 2 || previousEdgeUseCount !== nextEdgeUseCount;
};

const getFarthestIndexFromFirstPoint = (points: Point[]) => {
  const firstPoint = points[0] as Point;
  let farthestIndex = 1;
  let farthestDistance = -1;

  for (let index = 1; index < points.length; index += 1) {
    const distance = getSquaredDistance(points[index] as Point, firstPoint);

    if (distance > farthestDistance) {
      farthestIndex = index;
      farthestDistance = distance;
    }
  }

  return farthestIndex;
};

const getFallbackTriangle = (points: Point[]) => {
  if (points.length <= 3) {
    return points;
  }

  const farthestIndex = getFarthestIndexFromFirstPoint(points);
  let thirdIndex = 0;
  let thirdDistance = -1;

  for (let index = 1; index < points.length; index += 1) {
    if (index === farthestIndex) {
      continue;
    }

    const distance = getSquaredSegmentDistance(
      points[index] as Point,
      points[0] as Point,
      points[farthestIndex] as Point,
    );

    if (distance > thirdDistance) {
      thirdIndex = index;
      thirdDistance = distance;
    }
  }

  const indexes = Array.from(new Set([0, farthestIndex, thirdIndex])).sort(
    (first, second) => first - second,
  );

  return indexes.length >= 3 ? indexes.map((index) => points[index] as Point) : points.slice(0, 3);
};

const getDirectedArcPoints = (ring: RingInfo, startIndex: number, endIndex: number) => {
  const points: Point[] = [];
  let index = startIndex;

  points.push(ring.points[index] as Point);

  while (index !== endIndex) {
    index = (index + 1) % ring.points.length;
    points.push(ring.points[index] as Point);
  }

  return points;
};

export const buildCountryPaths = (
  geoJson: GeoJsonFeatureCollection,
  options: BuildOptions = defaultBuildOptions,
): BuildResult => {
  const { simplificationTolerance, minimumRingArea, maximumRingsPerCountry, coordinateDecimals } =
    options;

  const stats: BuildStats = {
    sourceRingCount: 0,
    keptRingCount: 0,
    sourcePointCount: 0,
    keptSourcePointCount: 0,
    outputPointCount: 0,
  };

  const simplifyOpenPolyline = (points: Point[]) => {
    if (points.length <= 2 || simplificationTolerance === 0) {
      return points;
    }

    const squaredTolerance = simplificationTolerance * simplificationTolerance;
    const keep = new Uint8Array(points.length);
    const stack: Array<[number, number]> = [[0, points.length - 1]];

    keep[0] = 1;
    keep[points.length - 1] = 1;

    while (stack.length > 0) {
      const [firstIndex, lastIndex] = stack.pop() as [number, number];
      const first = points[firstIndex] as Point;
      const last = points[lastIndex] as Point;
      let maximumDistance = squaredTolerance;
      let indexToKeep = 0;

      for (let index = firstIndex + 1; index < lastIndex; index += 1) {
        const distance = getSquaredSegmentDistance(points[index] as Point, first, last);

        if (distance > maximumDistance) {
          indexToKeep = index;
          maximumDistance = distance;
        }
      }

      if (indexToKeep > 0) {
        keep[indexToKeep] = 1;
        stack.push([firstIndex, indexToKeep], [indexToKeep, lastIndex]);
      }
    }

    return points.filter((_, index) => keep[index] === 1);
  };

  const simplifyClosedRing = (points: Point[]) => {
    if (points.length <= 3 || simplificationTolerance === 0) {
      return points;
    }

    const farthestIndex = getFarthestIndexFromFirstPoint(points);
    const firstHalf = simplifyOpenPolyline(points.slice(0, farthestIndex + 1));
    const secondHalf = simplifyOpenPolyline([...points.slice(farthestIndex), points[0] as Point]);
    const simplified = [...firstHalf, ...secondHalf.slice(1, -1)];

    return simplified.length >= 3 ? simplified : getFallbackTriangle(points);
  };

  const getOuterRingInfos = (geometry: GeoJsonGeometry | null | undefined) => {
    if (!geometry || !Array.isArray(geometry.coordinates)) {
      return [];
    }

    const outerRings =
      geometry.type === "Polygon"
        ? [geometry.coordinates[0]]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates.map((polygon) => (Array.isArray(polygon) ? polygon[0] : null))
          : [];

    return outerRings.flatMap((ring) => {
      if (!Array.isArray(ring)) {
        return [];
      }

      const points = removeClosingPoint(
        ring.map(toPoint).filter((point): point is Point => point !== null),
      );

      if (points.length < 3) {
        return [];
      }

      stats.sourceRingCount += 1;
      stats.sourcePointCount += points.length;

      return [{ points, area: getRingArea(points) }];
    });
  };

  const selectFeatureRings = (feature: GeoJsonFeature, featureIndex: number): RingInfo[] => {
    const ringInfos = getOuterRingInfos(feature.geometry).sort(
      (first, second) => second.area - first.area,
    );

    if (ringInfos.length === 0) {
      return [];
    }

    const selectedRingInfos = ringInfos
      .filter((ringInfo, index) => index === 0 || ringInfo.area >= minimumRingArea)
      .slice(0, maximumRingsPerCountry)
      .map((ringInfo, ringIndex) => ({
        ...ringInfo,
        featureIndex,
        ringIndex,
        keys: ringInfo.points.map(pointKey),
      }));

    stats.keptRingCount += selectedRingInfos.length;
    stats.keptSourcePointCount += selectedRingInfos.reduce(
      (total, ringInfo) => total + ringInfo.points.length,
      0,
    );

    return selectedRingInfos;
  };

  const arcCache = new Map<string, Point[]>();

  const getSimplifiedSharedArc = (arcPoints: Point[]) => {
    const keys = arcPoints.map(pointKey);
    const reversedKeys = [...keys].reverse();
    const forwardKey = keys.join("|");
    const reverseKey = reversedKeys.join("|");
    const isForwardCanonical = forwardKey <= reverseKey;
    const canonicalKey = isForwardCanonical ? forwardKey : reverseKey;

    if (!arcCache.has(canonicalKey)) {
      const canonicalPoints = isForwardCanonical ? arcPoints : [...arcPoints].reverse();

      arcCache.set(canonicalKey, simplifyOpenPolyline(canonicalPoints));
    }

    const simplifiedPoints = arcCache.get(canonicalKey) as Point[];

    return isForwardCanonical ? simplifiedPoints : [...simplifiedPoints].reverse();
  };

  const simplifyRingWithTopology = (ring: RingInfo, topology: Topology) => {
    const breakIndexes = ring.keys
      .map((_, index) => index)
      .filter((index) => isJunctionPoint(ring, index, topology));

    if (breakIndexes.length === 0) {
      return simplifyClosedRing(ring.points);
    }

    const simplifiedPoints: Point[] = [];

    for (let index = 0; index < breakIndexes.length; index += 1) {
      const startIndex = breakIndexes[index] as number;
      const endIndex = breakIndexes[(index + 1) % breakIndexes.length] as number;
      const arcPoints = getDirectedArcPoints(ring, startIndex, endIndex);
      const simplifiedArcPoints = getSimplifiedSharedArc(arcPoints);

      simplifiedPoints.push(
        ...(simplifiedPoints.length === 0 ? simplifiedArcPoints : simplifiedArcPoints.slice(1)),
      );
    }

    const output = removeClosingPoint(simplifiedPoints);

    return output.length >= 3 ? output : getFallbackTriangle(ring.points);
  };

  const formatNumber = (value: number) => {
    const rounded = Number(value.toFixed(coordinateDecimals));

    return Object.is(rounded, -0) ? "0" : String(rounded);
  };

  const pointToPathCoordinate = (point: Point) =>
    `${formatNumber(point[0])},${formatNumber(-point[1])}`;

  const ringToPath = (points: Point[]) => {
    stats.outputPointCount += points.length;

    return `M${points.map(pointToPathCoordinate).join(" ")}Z`;
  };

  const getCountryName = (feature: GeoJsonFeature, index: number) => {
    const rawName = feature?.properties?.name;

    return typeof rawName === "string" && rawName.trim() ? rawName.trim() : `Country ${index + 1}`;
  };

  const getCountryId = (feature: GeoJsonFeature, index: number, name: string) => {
    const rawId = feature?.id;
    const id = rawId === undefined || rawId === null ? name : String(rawId).trim();

    return `${index}-${id || name}`;
  };

  const features = Array.isArray(geoJson.features) ? geoJson.features : [];
  const selectedRingsByFeature = features.map(selectFeatureRings);
  const selectedRings = selectedRingsByFeature.flat();
  const topology = buildTopology(selectedRings);
  const countries = features
    .map((feature, index) => {
      const name = getCountryName(feature, index);
      const path = (selectedRingsByFeature[index] as RingInfo[])
        .map((ring) => ringToPath(simplifyRingWithTopology(ring, topology)))
        .join("");

      return {
        id: getCountryId(feature, index, name),
        name,
        path,
      };
    })
    .filter((country) => country.path.length > 0);

  return { countries, stats };
};

const getNumberEnv = (name: string, fallback: number) => {
  const value = Number.parseFloat(process.env[name] ?? String(fallback));

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return value;
};

const getIntegerEnv = (name: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }

  return value;
};

const main = async () => {
  const [
    ,
    ,
    sourceArg = "data/countries.geo.json",
    destinationArg = "public/countries.paths.json",
  ] = process.argv;

  const sourcePath = resolve(sourceArg);
  const destinationPath = resolve(destinationArg);

  const options: BuildOptions = {
    simplificationTolerance: getNumberEnv(
      "COUNTRY_MAP_TOLERANCE",
      defaultBuildOptions.simplificationTolerance,
    ),
    minimumRingArea: getNumberEnv("COUNTRY_MAP_MIN_AREA", defaultBuildOptions.minimumRingArea),
    maximumRingsPerCountry: getIntegerEnv(
      "COUNTRY_MAP_MAX_RINGS_PER_COUNTRY",
      defaultBuildOptions.maximumRingsPerCountry,
      1,
      100,
    ),
    coordinateDecimals: getIntegerEnv(
      "COUNTRY_MAP_DECIMALS",
      defaultBuildOptions.coordinateDecimals,
      0,
      6,
    ),
  };

  const geoJson = JSON.parse(await readFile(sourcePath, "utf8")) as GeoJsonFeatureCollection;
  const { countries, stats } = buildCountryPaths(geoJson, options);

  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, `${JSON.stringify({ countries })}\n`, "utf8");

  const outputBytes = Buffer.byteLength(await readFile(destinationPath, "utf8"), "utf8");

  console.log(
    `Wrote ${countries.length} countries to ${destinationArg} ` +
      `(${(outputBytes / 1024 / 1024).toFixed(2)} MiB).`,
  );
  console.log(
    `Kept ${stats.keptRingCount.toLocaleString()} of ` +
      `${stats.sourceRingCount.toLocaleString()} outer rings and simplified ` +
      `${stats.keptSourcePointCount.toLocaleString()} selected points to ` +
      `${stats.outputPointCount.toLocaleString()} points.`,
  );
  console.log(
    `Options: tolerance=${options.simplificationTolerance}, minArea=${options.minimumRingArea}, ` +
      `maxRingsPerCountry=${options.maximumRingsPerCountry}, decimals=${options.coordinateDecimals}.`,
  );
  console.log(
    `Source outer rings contained ${stats.sourcePointCount.toLocaleString()} total points.`,
  );
};

const isRunDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isRunDirectly) {
  await main();
}
