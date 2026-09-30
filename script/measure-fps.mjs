// Measure real in-game FPS with headed Edge (project devDependency: playwright-core).
// Usage: node script/measure-fps.mjs [seconds] [url] [width] [height] [dpr]
// Headed mode is required — headless SwiftShader deadlocks the engine render loop.
import { chromium } from "playwright-core";

const seconds = Number(process.argv[2] || 3);
const url = process.argv[3] || "http://localhost:13000/match";
const width = Number(process.argv[4] || 1280);
const height = Number(process.argv[5] || 720);
const dpr = Number(process.argv[6] || 1);

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  console.log(`[fps] opening ${url}  (${width}x${height}, dpr=${dpr})`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("[fps] waiting for match boot (body.loaded)...");
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  console.log("[fps] match loaded, waiting 3s to stabilise...");
  await page.waitForTimeout(3000);

  const result = await page.evaluate(async (secs) => {
    const webgl = (() => {
      try {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl2") || c.getContext("webgl");
        const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
        return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl ? "webgl-ok" : "no-webgl");
      } catch (e) { return "err:" + e.message; }
    })();
    let frames = 0, dropped = 0, last = 0;
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        if (last && now - last > 60) dropped++;
        last = now;
        frames++;
        if (now - t0 >= secs * 1000) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const elapsed = (performance.now() - t0) / 1000;
    return {
      fps: +(frames / elapsed).toFixed(1),
      frames,
      elapsedSec: +elapsed.toFixed(2),
      slowFrames: dropped,
      renderer: webgl,
      size: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    };
  }, seconds);

  console.log("[fps] ========== RESULT ==========");
  console.log("[fps] FPS:", result.fps, `(${result.frames} frames / ${result.elapsedSec}s)`);
  console.log("[fps] frames >60ms apart:", result.slowFrames);
  console.log("[fps] WebGL renderer:", result.renderer);
  console.log("[fps] viewport:", JSON.stringify(result.size));
} finally {
  await browser.close();
}
