#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";

const webBase = (process.argv[2] || "http://127.0.0.1:13000").replace(/\/$/, "");
const relayBase = (process.argv[3] || "http://127.0.0.1:13002").replace(/\/$/, "");
const artifactDir = path.resolve(process.env.ONLINE_TEST_ARTIFACTS || "/tmp/animal-cup-online-playtest");
const hardTimeout = 240_000;
const errors = [];
const contexts = [];

await mkdir(artifactDir, { recursive: true });

const hardTimer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, reason: `hard timeout ${hardTimeout}ms` }));
  process.exit(2);
}, hardTimeout);

const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.HEADLESS === "1",
  args: [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});

function observe(page, name) {
  page.on("pageerror", (error) => errors.push(`${name}: ${String(error).slice(0, 400)}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/favicon|React DevTools|animal-cup\/audio\//i.test(text)) return;
    errors.push(`${name}: ${text.slice(0, 300)}`);
  });
  return page;
}

async function makePage(name, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1280, height: 800 },
    hasTouch: !!options.hasTouch,
    isMobile: !!options.isMobile,
    deviceScaleFactor: 1,
  });
  contexts.push(context);
  if (options.storage) {
    await context.addInitScript(({ key, value }) => {
      try { sessionStorage.setItem(key, value); } catch {}
    }, options.storage);
  }
  return observe(await context.newPage(), name);
}

async function createRoom(config) {
  const response = await fetch(`${relayBase}/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`create failed: ${JSON.stringify(data)}`);
  return data;
}

async function waitRoom(page) {
  await page.locator(".or-status--ready").waitFor({ state: "visible", timeout: 30_000 });
  return (await page.locator(".or-code").innerText()).trim();
}

async function waitMatch(page, remote = false) {
  await page.waitForFunction(
    (needsRemote) => {
      const game = window.__matchGame;
      return !!(game?.pitch?.redTeam && game?.stadium && (!needsRemote || window.__onlineRemoteFrame));
    },
    remote,
    { timeout: 70_000 },
  );
  await page.waitForFunction(() => !document.querySelector(".cloud-curtain"), undefined, { timeout: 40_000 });
}

async function capture(page, name, requireCanvas = false) {
  await page.bringToFront();
  const pagePath = path.join(artifactDir, `${name}.png`);
  const canvasPath = path.join(artifactDir, `${name}-canvas.png`);
  const canvas = requireCanvas ? await page.evaluate(() => {
    const items = [...document.querySelectorAll("canvas")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 100 && item.rect.height > 100)
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    if (!items[0]) return null;
    return {
      x: items[0].rect.x,
      y: items[0].rect.y,
      width: items[0].rect.width,
      height: items[0].rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }) : null;
  await page.screenshot({ path: pagePath, type: "png" });
  if (!requireCanvas) return { pagePath };
  if (!canvas || canvas.width < 300 || canvas.height < 200) throw new Error(`${name}: game canvas missing`);
  const left = Math.max(0, Math.floor(canvas.x));
  const top = Math.max(0, Math.floor(canvas.y));
  const width = Math.max(1, Math.min(Math.ceil(canvas.width), canvas.viewportWidth - left));
  const height = Math.max(1, Math.min(Math.ceil(canvas.height), canvas.viewportHeight - top));
  await sharp(pagePath).extract({ left, top, width, height }).png().toFile(canvasPath);
  const stats = await sharp(canvasPath).stats();
  const variation = stats.channels.reduce((sum, channel) => sum + channel.stdev, 0);
  if (variation < 8) throw new Error(`${name}: game canvas appears blank`);
  return { pagePath, canvasPath, canvas, variation: Number(variation.toFixed(2)) };
}

function directState(page, remote) {
  return page.evaluate((isRemote) => {
    if (isRemote) {
      const frame = window.__onlineRemoteFrame;
      return {
        score: [frame.redTeam.score, frame.blueTeam.score],
        time: frame.matchTime,
        ball: { x: frame.ball.position.x, y: frame.ball.position.y },
        zoom: frame.camera.zoom,
      };
    }
    const pitch = window.__matchGame.pitch;
    return {
      score: [pitch.redTeam.score, pitch.blueTeam.score],
      time: pitch.matchTime,
      ball: { x: pitch.ball.position.x, y: pitch.ball.position.y },
      zoom: pitch.camera.zoom,
    };
  }, remote);
}

async function runDirect() {
  const host = await makePage("direct-host");
  const guest = await makePage("direct-guest", {
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
  });

  await Promise.all([
    host.goto(webBase, { waitUntil: "domcontentloaded", timeout: 30_000 }),
    guest.goto(webBase, { waitUntil: "domcontentloaded", timeout: 30_000 }),
  ]);
  const onlineButton = /Online Versus|公网对战/;
  await Promise.all([
    host.getByRole("button", { name: onlineButton }).click(),
    guest.getByRole("button", { name: onlineButton }).click(),
  ]);
  await Promise.all([
    host.getByRole("dialog").waitFor({ state: "visible" }),
    guest.getByRole("dialog").waitFor({ state: "visible" }),
  ]);
  const landingDesktop = await capture(host, "landing-online-desktop");
  const landingMobile = await capture(guest, "landing-online-mobile");

  await host.goto(
    `${webBase}/online?create=direct&red=argentina&blue=portugal&time=4&redForm=2-3-1&blueForm=3-2-1`,
    { waitUntil: "domcontentloaded", timeout: 30_000 },
  );
  const room = await waitRoom(host);
  await guest.goto(`${webBase}/online?room=${room}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitRoom(guest);
  await host.waitForFunction(() => !document.querySelector(".or-btn--start")?.disabled, undefined, { timeout: 20_000 });
  const lobby = await capture(host, "direct-lobby-host");

  await Promise.all([
    host.waitForURL(/\/match\?/, { timeout: 30_000 }),
    guest.waitForURL(/\/match\?/, { timeout: 30_000 }),
    host.locator(".or-btn--start").click(),
  ]);
  await Promise.all([waitMatch(host), waitMatch(guest, true)]);
  await guest.locator(".tc-stick").waitFor({ state: "visible", timeout: 10_000 });

  const stick = await guest.locator(".tc-stick").boundingBox();
  if (!stick) throw new Error("direct guest touch stick missing");
  await guest.bringToFront();
  await guest.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2);
  await guest.mouse.down();
  await guest.mouse.move(stick.x + stick.width * 0.85, stick.y + stick.height / 2, { steps: 5 });
  await host.waitForFunction(() => (window.__touchInput2?.vx || 0) > 0.35, undefined, { timeout: 5_000 });
  await guest.mouse.up();

  await guest.keyboard.down("ArrowRight");
  await host.waitForFunction(() => (window.__touchInput2?.vx || 0) > 0.7, undefined, { timeout: 5_000 });
  await guest.keyboard.up("ArrowRight");
  await host.waitForFunction(() => Math.abs(window.__touchInput2?.vx || 0) < 0.05, undefined, { timeout: 5_000 });

  await guest.waitForTimeout(700);
  const [hostState, guestState] = await Promise.all([directState(host, false), directState(guest, true)]);
  const ballDelta = Math.hypot(hostState.ball.x - guestState.ball.x, hostState.ball.y - guestState.ball.y);
  if (hostState.score.join(":") !== guestState.score.join(":")) throw new Error("direct score mismatch");
  if (!Number.isFinite(ballDelta) || ballDelta > 5) throw new Error(`direct ball drift ${ballDelta}`);
  if (!(guestState.zoom > 0 && guestState.zoom <= 3.1)) throw new Error(`direct guest zoom ${guestState.zoom}`);

  const hostShot = await capture(host, "direct-match-host", true);
  const guestShot = await capture(guest, "direct-match-guest-touch", true);
  return {
    room,
    landingDesktop,
    landingMobile,
    lobby,
    hostState,
    guestState,
    ballDelta: Number(ballDelta.toFixed(3)),
    hostShot,
    guestShot,
  };
}

async function runControllers() {
  const created = await createRoom({
    mode: "controllers",
    red: "england",
    blue: "france",
    time: 4,
    formations: { red: "2-3-1", blue: "3-2-1" },
  });
  const host = await makePage("controllers-host", {
    storage: { key: `animalCupOnline:host:${created.room}`, value: created.hostToken },
  });
  const guest = await makePage("controllers-guest");
  const pad1 = await makePage("controllers-pad1", {
    viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true,
  });
  const pad2 = await makePage("controllers-pad2", {
    viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true,
  });

  await host.goto(`${webBase}/online?room=${created.room}&host=1`, { waitUntil: "domcontentloaded" });
  await guest.goto(`${webBase}/online?room=${created.room}`, { waitUntil: "domcontentloaded" });
  await Promise.all([waitRoom(host), waitRoom(guest)]);
  await Promise.all([
    pad1.goto(`${webBase}/online-pad?room=${created.room}&slot=0&invite=${encodeURIComponent(created.padInvites[0])}`, { waitUntil: "domcontentloaded" }),
    pad2.goto(`${webBase}/online-pad?room=${created.room}&slot=1&invite=${encodeURIComponent(created.padInvites[1])}`, { waitUntil: "domcontentloaded" }),
  ]);
  await Promise.all([
    pad1.locator(".pad-state--ready").waitFor({ state: "visible", timeout: 20_000 }),
    pad2.locator(".pad-state--ready").waitFor({ state: "visible", timeout: 20_000 }),
  ]);
  await host.waitForFunction(() => !document.querySelector(".or-btn--start")?.disabled, undefined, { timeout: 20_000 });
  const hostLobby = await capture(host, "controllers-lobby-host-p1");
  const guestLobby = await capture(guest, "controllers-lobby-guest-p2");
  const padReady = await capture(pad2, "controllers-pad2-ready");

  await Promise.all([
    host.waitForURL(/\/match\?/, { timeout: 30_000 }),
    guest.waitForURL(/\/match\?/, { timeout: 30_000 }),
    host.locator(".or-btn--start").click(),
  ]);
  await Promise.all([
    waitMatch(host),
    waitMatch(guest, true),
    pad1.locator(".pad-state--playing").waitFor({ state: "visible", timeout: 30_000 }),
    pad2.locator(".pad-state--playing").waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  const pad1Context = pad1.context();
  await pad1Context.close();
  const pad1Index = contexts.indexOf(pad1Context);
  if (pad1Index >= 0) contexts.splice(pad1Index, 1);
  if (await host.locator(".tc, .ctrl-legend").count()) throw new Error("controller host shows local controls");
  if (await guest.locator(".tc, .ctrl-legend").count()) throw new Error("controller guest shows local controls");

  const shoot = await pad2.locator(".pad-btn--shoot").boundingBox();
  if (!shoot) throw new Error("P2 shoot button missing");
  await pad2.bringToFront();
  await pad2.mouse.move(shoot.x + shoot.width / 2, shoot.y + shoot.height / 2);
  await pad2.mouse.down();
  await host.waitForFunction(() => !!window.__touchInput2?.shoot, undefined, { timeout: 5_000 });
  await pad2.mouse.up();
  await host.waitForFunction(() => !window.__touchInput2?.shoot, undefined, { timeout: 5_000 });

  const hostShot = await capture(host, "controllers-match-host", true);
  const guestShot = await capture(guest, "controllers-match-guest", true);
  const padShot = await capture(pad2, "controllers-pad2-live");
  return { room: created.room, hostLobby, guestLobby, padReady, hostShot, guestShot, padShot };
}

try {
  const direct = await runDirect();
  for (const context of contexts.splice(0)) await context.close();
  const controllers = await runControllers();
  const realErrors = errors.filter((value) => !/Failed to load resource.*404/i.test(value));
  const fatalErrors = realErrors.filter((value) => /TypeError|ReferenceError|RangeError|online-frame|frame encode/i.test(value));
  const result = {
    ok: fatalErrors.length === 0,
    artifacts: artifactDir,
    direct,
    controllers,
    browserErrors: realErrors.slice(0, 12),
    fatalErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  clearTimeout(hardTimer);
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
}
