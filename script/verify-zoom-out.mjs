// Verify the widened zoom-out: URL zoom=0.35 and stepped-zoom minimum.
import { chromium } from "playwright-core";
import path from "node:path";

const BASE = "http://localhost:13000";
const root = "D:\\game\\github\\animal-world-cup";

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE-ERR:", m.text().slice(0, 200)); });

  // --- case A: URL zoom=0.35 (MATCH_ZOOM direct) ---
  await page.goto(`${BASE}/match?red=argentina&blue=portugal&play=1&zoom=0.35`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(9000); // intro + settle
  const a = await page.evaluate(() => ({
    mul: window.__matchZoomMul,
    zoomSet: (window.__matchZoom && window.__matchZoom.get && window.__matchZoom.get()),
    game: !!(window.__matchGame),
  })).catch(() => null);
  console.log("A state:", JSON.stringify(a));
  await page.screenshot({ path: path.join(root, ".scratch-zoom-035.png") });

  // --- case B: step zoom out to the floor via the UI multiplier ---
  await page.evaluate(() => { for (let i = 0; i < 15; i++) window.__matchZoom.step(1 / 1.18); });
  await page.waitForTimeout(2500);
  const b = await page.evaluate(() => ({
    mul: window.__matchZoomMul,
    zoomSet: (window.__matchZoom && window.__matchZoom.get && window.__matchZoom.get()),
  })).catch(() => null);
  console.log("B state:", JSON.stringify(b));
  await page.screenshot({ path: path.join(root, ".scratch-zoom-min.png") });

  await browser.close();
  console.log("DONE");
})().catch((e) => { console.error("SCRIPT ERROR:", e.message); process.exit(1); });
