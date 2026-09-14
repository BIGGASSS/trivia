import {
  test,
  expect,
  attempts,
  centerOf,
  expectCountryInMap,
  screenPoint,
  startSolo,
  zoomIn,
} from "./app";

for (const layout of [
  { name: "tall", width: 1100, height: 1000 },
  { name: "wide", width: 1800, height: 650 },
]) {
  test(`mouse drag and wheel anchors respect ${layout.name} SVG letterboxing`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await startSolo(page);
    await zoomIn(page);
    const map = page.locator("svg.world-map");
    const country = page.getByRole("button", { name: "Guess Center Island" });
    const box = await map.boundingBox();
    if (!box) throw new Error("Expected a rendered map");
    // Exercise both letterbox axes in the actual responsive layout, not CSS mocks.
    expect(
      layout.name === "tall" ? box.width / box.height < 1.8 : box.width / box.height > 2.2,
    ).toBe(true);

    const before = await centerOf(country);
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.mouse.move(before.x + 50, before.y + 35, { steps: 5 });
    await expect(map).toHaveClass(/world-map--panning/);
    const dragged = await centerOf(country);
    expect(dragged.x - before.x).toBeCloseTo(50, 0);
    expect(dragged.y - before.y).toBeCloseTo(35, 0);
    await page.mouse.up();
    await expect(map).not.toHaveClass(/world-map--panning/);
    await expect(attempts(page)).toHaveText("0");

    // Zoom about a non-central geographic point using real wheel input.
    const anchor = { x: 10, y: 5 };
    const anchorBefore = await screenPoint(page, anchor);
    const viewBoxBeforeWheel = await map.getAttribute("viewBox");
    await page.mouse.move(anchorBefore.x, anchorBefore.y);
    await page.mouse.wheel(0, -120);
    await expect(map).not.toHaveAttribute("viewBox", viewBoxBeforeWheel!);
    const anchorAfter = await screenPoint(page, anchor);
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 0);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 0);
    await expect(attempts(page)).toHaveText("0");

    // Drag suppression must not swallow the next intentional country click.
    await country.click();
    await expect(page.locator(".feedback")).toHaveText("Correct! That was Center Island.");
    await expect(attempts(page)).toHaveText("1");
  });
}

for (const key of ["Enter", "Space"]) {
  test(`keyboard focus reveals offscreen countries and ${key} guesses`, async ({ page }) => {
    await startSolo(page);
    await zoomIn(page, 5);
    const first = page.getByRole("button", { name: "Guess Center Island" });
    const west = page.getByRole("button", { name: "Guess West Island" });
    const east = page.getByRole("button", { name: "Guess East Island" });
    const map = page.locator("svg.world-map");
    const initialViewBox = await map.getAttribute("viewBox");
    await expect(west).not.toBeInViewport();
    await expect(east).not.toBeInViewport();

    // Enter through the real tab order; do not programmatically focus SVG paths.
    await page.keyboard.press("Tab"); // Zoom in -> Reset zoom
    await expect(page.getByRole("button", { name: "Reset zoom" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await expectCountryInMap(first);
    await page.keyboard.press("ArrowRight");
    await expect(west).toBeFocused();
    await expect(map).not.toHaveAttribute("viewBox", initialViewBox!);
    await expectCountryInMap(west);
    await expect(east).not.toBeInViewport();
    await page.keyboard.press("End");
    await expect(east).toBeFocused();
    await expectCountryInMap(east);
    await page.keyboard.press("ArrowRight"); // wrap to the first country
    await expect(first).toBeFocused();
    await expectCountryInMap(first);
    await page.keyboard.press("ArrowLeft"); // wrap backwards
    await expect(east).toBeFocused();
    await expectCountryInMap(east);
    await page.keyboard.press("Home");
    await expect(first).toBeFocused();
    await expectCountryInMap(first);
    await expect(map.locator('.country[tabindex="0"]')).toHaveCount(1);
    await expect(first).toHaveCSS("stroke-width", "2px");
    await expect(attempts(page)).toHaveText("0");

    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.keyboard.press(key);
    await expect(page.locator(".feedback")).toHaveText("Correct! That was Center Island.");
    await expect(attempts(page)).toHaveText("1");
    await expect(first).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press(key);
    await expect(attempts(page)).toHaveText("1");
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  });
}

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("focus and missed-country reveal are visible without animated movement", async ({
    page,
  }) => {
    await startSolo(page);
    await zoomIn(page, 5);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowRight");
    const west = page.getByRole("button", { name: "Guess West Island" });
    await expect(west).toBeFocused();
    await expectCountryInMap(west);
    await expect(west).toHaveCSS("transition-duration", "0s");
    const map = page.locator("svg.world-map");
    const before = await map.getAttribute("viewBox");
    const target = page.getByRole("button", { name: "Guess Center Island" });
    await expect(target).not.toBeInViewport();

    // Stop time only for the reveal assertions, not for pointer/keyboard input.
    const now = new Date();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now);
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(target).toHaveClass(/country--missed-target/);
    await expectCountryInMap(target);
    await expect(map).not.toHaveAttribute("viewBox", before!);
    const revealed = await map.getAttribute("viewBox");
    await page.clock.runFor(500);
    await expect(map).toHaveAttribute("viewBox", revealed!);

    await page.getByRole("button", { name: "Reset zoom" }).click();
    await expect(map).toHaveAttribute("viewBox", "-180 -90 360 180");
    await page.clock.runFor(2000);
    await expect(map).toHaveAttribute("viewBox", "-180 -90 360 180");
  });
});
