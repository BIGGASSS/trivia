import { readFile } from "node:fs/promises";
import { getLargestSubpathBounds } from "../../src/utils/svg-path-bounds";
import { test, expect, attempts, screenPoint, zoomIn } from "./app";

// Keep the Node-side browser fixture independent of the app's TypeScript aliases.
interface CountryPath {
  id: string;
  name: string;
  path: string;
}

const loadCountries = async (): Promise<CountryPath[]> => {
  const payload = JSON.parse(
    await readFile(new URL("../../dist/countries.paths.json", import.meta.url), "utf8"),
  ) as { countries: CountryPath[] };
  return payload.countries;
};

for (const { enclaveName, hostName, enclavePoint } of [
  { enclaveName: "Lesotho", hostName: "South Africa", enclavePoint: { x: 28.2, y: 29.6 } },
  {
    enclaveName: "Uzbekistan",
    hostName: "Kyrgyzstan",
    // Sokh enclave: 70.9820651°E, 40.0444406°N (SVG latitude is inverted).
    enclavePoint: { x: 70.9820651, y: -40.0444406 },
  },
]) {
  test(`${enclaveName} remains clickable through ${hostName}'s hole regardless of paint order`, async ({
    page,
  }) => {
    const countries = await loadCountries();
    const enclaveCountry = countries.find((country) => country.name === enclaveName)!;
    const hostCountry = countries.find((country) => country.name === hostName)!;
    // Paint the host last, so a missing hole cannot be hidden by the enclave.
    await page.route("**/countries.paths.json", (route) =>
      route.fulfill({ json: { countries: [enclaveCountry, hostCountry] } }),
    );
    await page.goto("/country-game/solo");
    await page.getByRole("spinbutton", { name: "Rounds" }).fill("1");
    await page.getByRole("button", { name: "Start solo game" }).click();
    await expect(page.locator(".target-country")).toHaveText(enclaveName);

    const host = page.getByRole("button", { name: `Guess ${hostName}` });
    const enclave = page.getByRole("button", { name: `Guess ${enclaveName}` });
    expect(
      await host.evaluate(
        (path: SVGPathElement, point) => path.isPointInFill(new DOMPoint(point.x, point.y)),
        enclavePoint,
      ),
    ).toBe(false);
    expect(
      await enclave.evaluate(
        (path: SVGPathElement, point) => path.isPointInFill(new DOMPoint(point.x, point.y)),
        enclavePoint,
      ),
    ).toBe(true);

    // Magnify around the enclave, keeping it away from the host's stroke.
    let point = await screenPoint(page, enclavePoint);
    for (let index = 0; index < 14; index += 1) {
      const before = await page.locator("svg.world-map").getAttribute("viewBox");
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, -120);
      await expect(page.locator("svg.world-map")).not.toHaveAttribute("viewBox", before!);
      point = await screenPoint(page, enclavePoint);
    }
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"),
        point,
      ),
    ).toBe(`Guess ${enclaveName}`);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(".feedback")).toHaveText(`Correct! That was ${enclaveName}.`);
    await expect(attempts(page)).toHaveText("1");
  });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test.describe(`real-country reveal (${reducedMotion})`, () => {
    test.use({ reducedMotion });

    test("Norway's mainland fits when revealing from zoom 64", async ({ page }) => {
      const countries = await loadCountries();
      const norway = countries.find((country) => country.name === "Norway")!;
      const bounds = getLargestSubpathBounds(norway.path)!;
      await page.route("**/countries.paths.json", (route) =>
        route.fulfill({ json: { countries: [norway] } }),
      );
      await page.goto("/country-game/solo");
      await page.getByRole("spinbutton", { name: "Rounds" }).fill("1");
      await page.getByRole("button", { name: "Start solo game" }).click();
      await expect(page.locator(".target-country")).toHaveText("Norway");
      await zoomIn(page, 14);
      await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled();
      const map = page.locator("svg.world-map");
      const original = await map.getAttribute("viewBox");
      const now = new Date();
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now);
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page.clock.runFor(1200);
      await expect(page.getByRole("button", { name: "Guess Norway" })).toHaveClass(
        /country--missed-target/,
      );

      const viewBox = await map.evaluate((svg: SVGSVGElement) => {
        const { x, y, width, height } = svg.viewBox.baseVal;
        return { x, y, width, height };
      });
      // SVGAnimatedRect exposes float32 values, unlike the app's JS calculations.
      expect(bounds.width / viewBox.width).toBeLessThanOrEqual(0.62 + 1e-6);
      expect(bounds.height / viewBox.height).toBeLessThanOrEqual(0.62 + 1e-6);
      const topLeft = await screenPoint(page, bounds);
      const bottomRight = await screenPoint(page, {
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height,
      });
      const box = (await map.boundingBox())!;
      expect(topLeft.x).toBeGreaterThan(box.x);
      expect(topLeft.y).toBeGreaterThan(box.y);
      expect(bottomRight.x).toBeLessThan(box.x + box.width);
      expect(bottomRight.y).toBeLessThan(box.y + box.height);

      // Check restoration before the 2600ms next-round/results transition.
      await page.clock.runFor(1300);
      await expect(map).toHaveAttribute("viewBox", original!);
    });
  });
}
