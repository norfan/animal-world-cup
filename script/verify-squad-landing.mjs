// Verify the Landing squad picker: renders, click-through URL carries &squad=.
// Usage: node script/verify-squad-landing.mjs
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge", headless: false });
let pass = true;
const check = (n, ok, extra) => { console.log(`[squad-landing] ${ok ? "PASS" : "FAIL"} ${n}${extra ? " :: " + extra : ""}`); if (!ok) pass = false; };

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto("http://localhost:13000/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("text=2v2", { timeout: 15000 });
  console.log("[squad-landing] squad group visible (2v2..6v6)");

  // click 2v2 then watch
  await page.click("text=2v2");
  await page.click("text=Watch AI vs AI");
  await page.waitForURL("**/match?**", { timeout: 15000 });
  const u2 = page.url();
  check("watch URL carries squad=2", u2.includes("squad=2"), u2);

  // back to landing, 4v4 then kickoff (wait for the reveal so buttons are clickable)
  await page.goto("http://localhost:13000/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("text=2v2", { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.click("text=4v4");
  await page.waitForTimeout(300);
  await page.click("text=Kick Off");
  await page.waitForURL("**/match?**", { timeout: 15000 });
  const u4 = page.url();
  check("kickoff URL carries squad=4", u4.includes("squad=4") && u4.includes("play=1"), u4);
} catch (e) {
  console.log("[squad-landing] ERROR", e && e.message);
  pass = false;
}

await browser.close();
console.log(pass ? "ALL PASS" : "SOME FAIL");
process.exit(pass ? 0 : 1);
