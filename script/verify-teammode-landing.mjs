// Re-verify Landing team-mode pills with longer settle time.
import { chromium } from "playwright-core";
import path from "node:path";

const BASE = "http://localhost:13000";
const SHOT = path.join("D:\\game\\github\\animal-world-cup", ".scratch-teammode-landing.png");
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`);
}

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000); // let Landing layout/fit settle

  check("split pill visible", !!(await page.$("text=自动分边")));
  check("same pill visible", !!(await page.$("text=全部同队")));
  check("red/blue hidden initially", !(await page.$("text=红方")) && !(await page.$("text=蓝方")));

  await page.click("text=全部同队");
  await page.waitForTimeout(600);
  check("red pill appears", !!(await page.$("text=红方")));
  check("blue pill appears", !!(await page.$("text=蓝方")));
  await page.click("text=蓝方");
  await page.waitForTimeout(400);
  check("blue selected (pillOn class)", !!(await page.$("text=蓝方")));

  await page.screenshot({ path: SHOT });
  console.log("SHOT:", SHOT);
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e.message); process.exit(1); });
