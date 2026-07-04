import { describe, expect, it } from "vite-plus/test";
import { buildCountryPaths, defaultBuildOptions } from "../build-country-paths";

const square = (x: number, y: number, size: number) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];

const fixture = {
  type: "FeatureCollection",
  features: [
    {
      id: "AAA",
      properties: { name: "Alphaland" },
      geometry: { type: "Polygon", coordinates: [square(0, 0, 10)] },
    },
    {
      id: "BBB",
      properties: { name: "Betamark" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [[square(20, 0, 5)], [square(40, 40, 1)]],
      },
    },
    {
      // Unnamed feature falls back to a generated name.
      properties: {},
      geometry: { type: "Polygon", coordinates: [square(-30, -30, 2)] },
    },
    {
      // Feature without usable geometry is dropped.
      id: "EMPTY",
      properties: { name: "Nowhere" },
      geometry: { type: "Point", coordinates: [0, 0] },
    },
  ],
};

describe("buildCountryPaths", () => {
  it("converts polygon features into closed SVG paths", () => {
    const { countries } = buildCountryPaths(fixture, defaultBuildOptions);

    expect(countries).toHaveLength(3);
    expect(countries.map((country) => country.name)).toEqual([
      "Alphaland",
      "Betamark",
      "Country 3",
    ]);
    expect(countries.map((country) => country.id)).toEqual(["0-AAA", "1-BBB", "2-Country 3"]);

    for (const country of countries) {
      // Every subpath is absolute `M x,y x,y …Z` with y flipped for SVG.
      expect(country.path).toMatch(/^(M(-?\d+(\.\d+)?,-?\d+(\.\d+)? ?)+Z)+$/);
    }
  });

  it("flips the y axis so north is up", () => {
    const { countries } = buildCountryPaths(
      {
        features: [
          {
            id: "N",
            properties: { name: "North" },
            geometry: { type: "Polygon", coordinates: [square(0, 10, 5)] },
          },
        ],
      },
      defaultBuildOptions,
    );

    // Latitude 10..15 becomes SVG y -10..-15.
    expect(countries[0]?.path).toContain("-10");
    expect(countries[0]?.path).not.toContain(",10 ");
  });

  it("keeps a MultiPolygon's largest ring and drops rings under the minimum area", () => {
    const { countries, stats } = buildCountryPaths(
      {
        features: [
          {
            id: "M",
            properties: { name: "Multi" },
            geometry: {
              type: "MultiPolygon",
              // Second ring is far below the 0.02 minimum ring area.
              coordinates: [[square(0, 0, 10)], [square(50, 50, 0.01)]],
            },
          },
        ],
      },
      defaultBuildOptions,
    );

    expect(countries).toHaveLength(1);
    expect(stats.sourceRingCount).toBe(2);
    expect(stats.keptRingCount).toBe(1);
    expect(countries[0]?.path.match(/M/g)).toHaveLength(1);
  });

  it("rounds coordinates to the configured number of decimals", () => {
    const { countries } = buildCountryPaths(
      {
        features: [
          {
            id: "R",
            properties: { name: "Rounded" },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0.123456, 0],
                  [10.987654, 0],
                  [10.987654, 10],
                  [0.123456, 10],
                  [0.123456, 0],
                ],
              ],
            },
          },
        ],
      },
      { ...defaultBuildOptions, coordinateDecimals: 2 },
    );

    expect(countries[0]?.path).toContain("0.12");
    expect(countries[0]?.path).toContain("10.99");
    expect(countries[0]?.path).not.toContain("0.123");
  });

  it("returns no countries for an empty collection", () => {
    expect(buildCountryPaths({ features: [] }).countries).toEqual([]);
    expect(buildCountryPaths({}).countries).toEqual([]);
  });
});
