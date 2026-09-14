import { devices } from "@playwright/test";
import { test, expect, attempts, centerOf, screenPoint, startSolo } from "./app";

test.use({ ...devices["Pixel 7"] });

test("mobile two-finger pinch tracks its moving anchor and leaves tapping usable", async ({
  page,
  context,
}) => {
  await startSolo(page);
  const map = page.locator("svg.world-map");
  await map.scrollIntoViewIfNeeded();
  const box = await map.boundingBox();
  if (!box) throw new Error("Expected a rendered map");
  expect(box.width / box.height).toBeLessThan(1.8);
  await expect(map).toHaveCSS("touch-action", "none");

  const anchor = { x: 20, y: 0 };
  const before = await screenPoint(page, anchor);
  const after = { x: before.x + 15, y: before.y + 10 };
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const client = await context.newCDPSession(page);
  const contacts = (center: { x: number; y: number }, halfDistance: number) => [
    { id: 1, x: center.x - halfDistance, y: center.y },
    { id: 2, x: center.x + halfDistance, y: center.y },
  ];
  try {
    // CDP generates browser touch/pointer events and real pointer capture, not dispatchEvent mocks.
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: contacts(before, 25),
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: contacts(after, 45),
    });
    await expect(page.locator(".zoom-level")).toHaveText("180%");
    const projected = await screenPoint(page, anchor);
    expect(projected.x).toBeCloseTo(after.x, 0);
    expect(projected.y).toBeCloseTo(after.y, 0);
    await expect(map).toHaveClass(/world-map--panning/);
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(map).not.toHaveClass(/world-map--panning/);
    await expect(attempts(page)).toHaveText("0");
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

    const country = page.getByRole("button", { name: "Guess Center Island" });
    const target = await centerOf(country);
    await page.touchscreen.tap(target.x, target.y);
    await expect(page.locator(".feedback")).toHaveText("Correct! That was Center Island.");
    await expect(attempts(page)).toHaveText("1");
  } finally {
    await client.detach();
  }
});
