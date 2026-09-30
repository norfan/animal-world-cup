// Verify the LAN team-mode UI on the live dev server (13000):
// Landing shows the new "联机分配" pills, same-team + blue selection flows
// through to /lobby and the lobby shows the mode note.
import { chromium } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:13000";
const SHOT = path.join("D:\\game\\github\\animal-world-cup", ".scratch-teammode-ui.png");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`);
}

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  // Landing rendered?
  const wrap = await page.$("text=动物世界杯");
  check("landing rendered", !!wrap);

  // new team-mode group present
  const modeLabel = await page.$(`text=联机分配`);
  check("team-mode label visible", !!modeLabel);

  const pills = await page.$$("button");
  const pillTexts = [];
  for (const p of pills) pillTexts.push((await p.textContent()).trim());
  check("split pill exists", pillTexts.includes("自动分边"));
  check("same-team pill exists", pillTexts.includes("全部同队"));
  check("red/blue not shown before same-team", !pillTexts.includes("红方") && !pillTexts.includes("蓝方"), pillTexts.join(","));

  // click 全部同队 -> red/blue appear; click 蓝方
  await page.click("text=全部同队");
  await page.waitForTimeout(400);
  const after = [];
  for (const p of await page.$$("button")) after.push((await p.textContent()).trim());
  check("red/blue appear after same-team", after.includes("红方") && after.includes("蓝方"), after.join(","));
  await page.click("text=蓝方");
  await page.waitForTimeout(400);

  // go LAN
  await page.click("text=局域网对战");
  await page.waitForURL(/\/lobby\?/, { timeout: 15000 });
  const url = page.url();
  check("lobby URL carries teamMode=same&sameSide=blue", url.includes("teamMode=same") && url.includes("sameSide=blue"), url);
  await page.waitForTimeout(2000);

  const body = await page.textContent("body");
  check("lobby shows same-team note", body.includes("同队模式") && body.includes("蓝方"), (body.match(/同队模式[^。]*。/g) || [""])[0]);

  await page.screenshot({ path: SHOT, fullPage: false });
  console.log("SHOT:", SHOT);

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e.message); process.exit(1); });
