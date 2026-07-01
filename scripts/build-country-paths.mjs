#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [, , sourceArg = "data/countries.geo.json", destinationArg = "public/countries.paths.json"] =
  process.argv;

const sourcePath = resolve(sourceArg);
const destinationPath = resolve(destinationArg);

const getNumberEnv = (name, fallback) => {
  const value = Number.parseFloat(process.env[name] ?? String(fallback));

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return value;
};

const getIntegerEnv = (name, fallback, minimum, maximum) => {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }

  return value;
};

// Simplify shared borders as shared arcs. This avoids the ocean-colored cracks
// caused by simplifying each country independently, without turning borders into
// blocky grid steps.
const simplificationTolerance = getNumberEnv("COUNTRY_MAP_TOLERANCE", 0.08);
const minimumRingArea = getNumberEnv("COUNTRY_MAP_MIN_AREA", 0.02);
const maximumRingsPerCountry = getIntegerEnv("COUNTRY_MAP_MAX_RINGS_PER_COUNTRY", 20, 1, 100);
const coordinateDecimals = getIntegerEnv("COUNTRY_MAP_DECIMALS", 3, 0, 6);

let sourceRingCount = 0;
let keptRingCount = 0;
let sourcePointCount = 0;
let keptSourcePointCount = 0;
let outputPointCount = 0;

const getSquaredDistance = (first, second) => {
  const deltaX = first[0] - second[0];
  const deltaY = first[1] - second[1];

  return deltaX * deltaX + deltaY * deltaY;
};

const getSquaredSegmentDistance = (point, first, second) => {
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

const simplifyOpenPolyline = (points) => {
  if (points.length <= 2 || simplificationTolerance === 0) {
    return points;
  }

  const squaredTolerance = simplificationTolerance * simplificationTolerance;
  const keep = new Uint8Array(points.length);
  const stack = [[0, points.length - 1]];

  keep[0] = 1;
  keep[points.length - 1] = 1;

  while (stack.length > 0) {
    const [firstIndex, lastIndex] = stack.pop();
    const first = points[firstIndex];
    const last = points[lastIndex];
    let maximumDistance = squaredTolerance;
    let indexToKeep = 0;

    for (let index = firstIndex + 1; index < lastIndex; index += 1) {
      const distance = getSquaredSegmentDistance(points[index], first, last);

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

const toPoint = (coordinate) => {
  if (!Array.isArray(coordinate)) {
    return null;
  }

  const longitude = Number(coordinate[0]);
  const latitude = Number(coordinate[1]);

  return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null;
};

const pointsMatch = (first, second) => first[0] === second[0] && first[1] === second[1];

const removeClosingPoint = (points) => {
  if (points.length > 1 && pointsMatch(points[0], points[points.length - 1])) {
    return points.slice(0, -1);
  }

  return points;
};

const getRingArea = (points) => {
  let area = 0;

  for (
    let index = 0, previousIndex = points.length - 1;
    index < points.length;
    previousIndex = index, index += 1
  ) {
    const [previousX, previousY] = points[previousIndex];
    const [x, y] = points[index];

    area += previousX * y - x * previousY;
  }

  return Math.abs(area) / 2;
};

const pointKey = (point) => `${point[0]},${point[1]}`;

const edgeKey = (firstKey, secondKey) =>
  firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;

const addAdjacentPoint = (adjacency, firstKey, secondKey) => {
  const adjacentPoints = adjacency.get(firstKey) ?? new Set();

  adjacentPoints.add(secondKey);
  adjacency.set(firstKey, adjacentPoints);
};

const getOuterRingInfos = (geometry) => {
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    return [];
  }

  const outerRings =
    geometry.type === "Polygon"
      ? [geometry.coordinates[0]]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates.map((polygon) => polygon?.[0])
        : [];

  return outerRings.flatMap((ring) => {
    if (!Array.isArray(ring)) {
      return [];
    }

    const points = removeClosingPoint(ring.map(toPoint).filter(Boolean));

    if (points.length < 3) {
      return [];
    }

    sourceRingCount += 1;
    sourcePointCount += points.length;

    return [{ points, area: getRingArea(points) }];
  });
};

const selectFeatureRings = (feature, featureIndex) => {
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

  keptRingCount += selectedRingInfos.length;
  keptSourcePointCount += selectedRingInfos.reduce(
    (total, ringInfo) => total + ringInfo.points.length,
    0,
  );

  return selectedRingInfos;
};

const buildTopology = (rings) => {
  const edgeUseCounts = new Map();
  const adjacency = new Map();

  for (const ring of rings) {
    for (let index = 0; index < ring.keys.length; index += 1) {
      const firstKey = ring.keys[index];
      const secondKey = ring.keys[(index + 1) % ring.keys.length];
      const key = edgeKey(firstKey, secondKey);

      edgeUseCounts.set(key, (edgeUseCounts.get(key) ?? 0) + 1);
      addAdjacentPoint(adjacency, firstKey, secondKey);
      addAdjacentPoint(adjacency, secondKey, firstKey);
    }
  }

  return { edgeUseCounts, adjacency };
};

const isJunctionPoint = (ring, index, topology) => {
  const currentKey = ring.keys[index];
  const previousKey = ring.keys[(index - 1 + ring.keys.length) % ring.keys.length];
  const nextKey = ring.keys[(index + 1) % ring.keys.length];
  const previousEdgeUseCount = topology.edgeUseCounts.get(edgeKey(previousKey, currentKey)) ?? 0;
  const nextEdgeUseCount = topology.edgeUseCounts.get(edgeKey(currentKey, nextKey)) ?? 0;
  const adjacentPointCount = topology.adjacency.get(currentKey)?.size ?? 0;

  return adjacentPointCount !== 2 || previousEdgeUseCount !== nextEdgeUseCount;
};

const getFarthestIndexFromFirstPoint = (points) => {
  let farthestIndex = 1;
  let farthestDistance = -1;

  for (let index = 1; index < points.length; index += 1) {
    const distance = getSquaredDistance(points[index], points[0]);

    if (distance > farthestDistance) {
      farthestIndex = index;
      farthestDistance = distance;
    }
  }

  return farthestIndex;
};

const getFallbackTriangle = (points) => {
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

    const distance = getSquaredSegmentDistance(points[index], points[0], points[farthestIndex]);

    if (distance > thirdDistance) {
      thirdIndex = index;
      thirdDistance = distance;
    }
  }

  const indexes = Array.from(new Set([0, farthestIndex, thirdIndex])).sort(
    (first, second) => first - second,
  );

  return indexes.length >= 3 ? indexes.map((index) => points[index]) : points.slice(0, 3);
};

const simplifyClosedRing = (points) => {
  if (points.length <= 3 || simplificationTolerance === 0) {
    return points;
  }

  const farthestIndex = getFarthestIndexFromFirstPoint(points);
  const firstHalf = simplifyOpenPolyline(points.slice(0, farthestIndex + 1));
  const secondHalf = simplifyOpenPolyline([...points.slice(farthestIndex), points[0]]);
  const simplified = [...firstHalf, ...secondHalf.slice(1, -1)];

  return simplified.length >= 3 ? simplified : getFallbackTriangle(points);
};

const getDirectedArcPoints = (ring, startIndex, endIndex) => {
  const points = [];
  let index = startIndex;

  points.push(ring.points[index]);

  while (index !== endIndex) {
    index = (index + 1) % ring.points.length;
    points.push(ring.points[index]);
  }

  return points;
};

const arcCache = new Map();

const getSimplifiedSharedArc = (arcPoints) => {
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

  const simplifiedPoints = arcCache.get(canonicalKey);

  return isForwardCanonical ? simplifiedPoints : [...simplifiedPoints].reverse();
};

const simplifyRingWithTopology = (ring, topology) => {
  const breakIndexes = ring.keys
    .map((_, index) => index)
    .filter((index) => isJunctionPoint(ring, index, topology));

  if (breakIndexes.length === 0) {
    return simplifyClosedRing(ring.points);
  }

  const simplifiedPoints = [];

  for (let index = 0; index < breakIndexes.length; index += 1) {
    const startIndex = breakIndexes[index];
    const endIndex = breakIndexes[(index + 1) % breakIndexes.length];
    const arcPoints = getDirectedArcPoints(ring, startIndex, endIndex);
    const simplifiedArcPoints = getSimplifiedSharedArc(arcPoints);

    simplifiedPoints.push(
      ...(simplifiedPoints.length === 0 ? simplifiedArcPoints : simplifiedArcPoints.slice(1)),
    );
  }

  const output = removeClosingPoint(simplifiedPoints);

  return output.length >= 3 ? output : getFallbackTriangle(ring.points);
};

const formatNumber = (value) => {
  const rounded = Number(value.toFixed(coordinateDecimals));

  return Object.is(rounded, -0) ? "0" : String(rounded);
};

const pointToPathCoordinate = (point) => `${formatNumber(point[0])},${formatNumber(-point[1])}`;

const ringToPath = (points) => {
  outputPointCount += points.length;

  return `M${points.map(pointToPathCoordinate).join(" ")}Z`;
};

const getCountryName = (feature, index) => {
  const rawName = feature?.properties?.name;

  return typeof rawName === "string" && rawName.trim() ? rawName.trim() : `Country ${index + 1}`;
};

const getCountryId = (feature, index, name) => {
  const rawId = feature?.id;
  const id = rawId === undefined || rawId === null ? name : String(rawId).trim();

  return `${index}-${id || name}`;
};

const geoJson = JSON.parse(await readFile(sourcePath, "utf8"));
const features = Array.isArray(geoJson.features) ? geoJson.features : [];
const selectedRingsByFeature = features.map(selectFeatureRings);
const selectedRings = selectedRingsByFeature.flat();
const topology = buildTopology(selectedRings);
const countries = features
  .map((feature, index) => {
    const name = getCountryName(feature, index);
    const path = selectedRingsByFeature[index]
      .map((ring) => ringToPath(simplifyRingWithTopology(ring, topology)))
      .join("");

    return {
      id: getCountryId(feature, index, name),
      name,
      path,
    };
  })
  .filter((country) => country.path.length > 0);

await mkdir(dirname(destinationPath), { recursive: true });
await writeFile(destinationPath, `${JSON.stringify({ countries })}\n`, "utf8");

const outputBytes = Buffer.byteLength(await readFile(destinationPath, "utf8"), "utf8");

console.log(
  `Wrote ${countries.length} countries to ${destinationArg} ` +
    `(${(outputBytes / 1024 / 1024).toFixed(2)} MiB).`,
);
console.log(
  `Kept ${keptRingCount.toLocaleString()} of ` +
    `${sourceRingCount.toLocaleString()} outer rings and simplified ` +
    `${keptSourcePointCount.toLocaleString()} selected points to ` +
    `${outputPointCount.toLocaleString()} points.`,
);
console.log(
  `Options: tolerance=${simplificationTolerance}, minArea=${minimumRingArea}, ` +
    `maxRingsPerCountry=${maximumRingsPerCountry}, decimals=${coordinateDecimals}.`,
);
console.log(`Source outer rings contained ${sourcePointCount.toLocaleString()} total points.`);
