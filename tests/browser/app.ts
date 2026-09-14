import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base, type Locator, type Page } from "@playwright/test";

const distDirectory = fileURLToPath(new URL("../../dist/", import.meta.url));
const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Small, separated countries make clipping and pointer hit-testing unambiguous.
// Only the data is replaced; all app code, SVG rendering, and event handling are real.
const countries = [
  { id: "center", name: "Center Island", path: "M-7,-7H7V7H-7Z" },
  { id: "west", name: "West Island", path: "M-127,-37H-113V-23H-127Z" },
  { id: "east", name: "East Island", path: "M113,23H127V37H113Z" },
];

export const test = base.extend({
  page: async ({ page }, use) => {
    // Fail before navigation with a useful error if invoked without a build.
    const index = await readFile(resolve(distDirectory, "index.html"));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://trivia.test") {
        await route.abort("blockedbyclient");
        throw new Error(`Unexpected external request: ${url.href}`);
      }
      if (url.pathname === "/countries.paths.json") {
        await route.fulfill({ json: { countries } });
        return;
      }
      if (route.request().isNavigationRequest()) {
        await route.fulfill({ contentType: "text/html", body: index });
        return;
      }
      const path = resolve(distDirectory, `.${decodeURIComponent(url.pathname)}`);
      if (!path.startsWith(`${resolve(distDirectory)}${sep}`)) {
        await route.abort("accessdenied");
        return;
      }
      await route.fulfill({
        body: await readFile(path),
        contentType: contentTypes[extname(path)] ?? "application/octet-stream",
      });
    });
    // The first round always prompts Center Island, without mocking game methods.
    await page.addInitScript(() => {
      Math.random = () => 0;
    });
    await use(page);
  },
});

export { expect };

export async function startSolo(page: Page) {
  await page.goto("/country-game/solo");
  await page.getByRole("spinbutton", { name: "Rounds" }).fill("3");
  await page.getByRole("button", { name: "Start solo game" }).click();
  await expect(page.locator(".target-country")).toHaveText("Center Island");
  await expect(page.locator("svg.world-map")).toBeVisible();
}

export async function zoomIn(page: Page, count = 4) {
  for (let i = 0; i < count; i += 1) {
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  }
}

export async function centerOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected a rendered bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function screenPoint(page: Page, point: { x: number; y: number }) {
  return page.locator("svg.world-map").evaluate((svg: SVGSVGElement, point) => {
    const transform = svg.getScreenCTM();
    if (!transform) throw new Error("SVG has no screen transform");
    const projected = new DOMPoint(point.x, point.y).matrixTransform(transform);
    return { x: projected.x, y: projected.y };
  }, point);
}

export async function expectCountryInMap(country: Locator) {
  await expect(country).toBeInViewport({ ratio: 1 });
  // Playwright's visible check alone does not detect SVG viewBox clipping.
  await expect
    .poll(() =>
      country.evaluate((path: SVGPathElement) => {
        const map = path.ownerSVGElement!.getBoundingClientRect();
        const box = path.getBoundingClientRect();
        return (
          box.left >= map.left &&
          box.right <= map.right &&
          box.top >= map.top &&
          box.bottom <= map.bottom
        );
      }),
    )
    .toBe(true);
}

export function attempts(page: Page) {
  return page
    .locator(".scoreboard div")
    .filter({ has: page.getByText("Attempts", { exact: true }) })
    .locator("dd");
}
