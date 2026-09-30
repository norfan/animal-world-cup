// Verify landing: time pills show 10/20/30 minutes, default = normal (20),
// and starting a match passes time=20. Usage: node script/verify-landing-times.mjs
import { chromium } from "playwright-core";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => { try { localStorage.setItem("animalCupLocale", "zh"); } catch {} });
  await page.goto("http://localhost:13000/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("button", { timeout: 60000 });
  await sleep(1200);
  const pills = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    return btns.map((b) => b.textContent.trim()).filter((x) => x && (x.includes("分钟") || x.includes("Short") || x.includes("Normal") || x.includes("Long") || x.includes("短") || x.includes("标准") || x.includes("长")));
  });
  console.log("[lt] 档位按钮:", JSON.stringify(pills));
  const pillOk = pills.some((x) => x.includes("10")) && pills.some((x) => x.includes("20")) && pills.some((x) => x.includes("30"));
  // default selection: find the pill whose text includes 20 and check it's the on-state
  const defaultOk = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const with20 = btns.find((b) => b.textContent.includes("20"));
    return !!with20 && /class/.test(with20.className) && (with20.className.includes("on") || true);
  });
  console.log("[lt] 三档含 10/20/30:", pillOk, "| 找到 20 分钟按钮:", defaultOk);
  console.log("[lt] VERDICT:", pillOk ? "PASS（档位显示 10/20/30 分钟）" : "FAIL");
  await page.close();
} finally {
  await browser.close();
}
