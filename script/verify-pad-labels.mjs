#!/usr/bin/env node
/**
 * verify-pad-labels — P3 acceptance test: the overhead seat label layer.
 * See docs/multiplayer-4v4-design.md §3.4 and §4 "P3 验收".
 *
 * WHAT IT PROVES
 * `public/match-runtime-min/standalone-match.js` grows a `window.__acLabels`
 * layer that draws one capsule above every player: a jersey number for all 14,
 * plus a nickname and the seat's own colour for the 8 that a phone holds.
 *
 *   1. build    — 14 capsules, one per squad member, attached to stadium.topLayer
 *                 (above `sortables`, so no player can ever cover a label), and
 *                 every capsule found its player's renderer.
 *   2. numbers  — red 1..7 and blue 1..7, the GK getting 1, every number
 *                 agreeing with the seat the relay handed that phone, and every
 *                 number agreeing with the jersey number the engine paints on
 *                 that player's shirt (read off the spine skin name).
 *   3. colour   — the 8 humans carry 8 distinct seat colours with readable ink,
 *                 the 6 AI are one neutral slate with no nickname.
 *   4. geometry — every tip sits exactly `lift` px above the independently
 *                 reprojected feet point, and inside a readable gap above the
 *                 head the engine actually paints (measured from the player's
 *                 RenderTexture pixels, NOT from the layer's own lift constant —
 *                 otherwise the check would validate the lift against itself).
 *   5. tracking — across camera movement the offset never drifts, and the camera
 *                 genuinely moved (so the check cannot pass vacuously).
 *   6. toggle   — the HUD switch hides/shows the layer and persists; with no
 *                 seats at all the layer draws nothing, i.e. a solo 1v1 match is
 *                 visually unchanged.
 *   7. drop     — a phone that leaves turns its capsule back into an AI capsule
 *                 (neutral, no nickname) while keeping its number.
 *
 * ISOLATION
 * A scratch relay is spawned on its own port and `window.__lanPort` points the
 * page at it, so the user's running relay on 13001 is never touched and the code
 * under test is always the code on disk.
 *
 * HEADED Chrome only — headless SwiftShader wedges the engine render loop.
 *
 * Usage:  node script/verify-pad-labels.mjs [baseUrl]
 * Needs:  a running dev server (pnpm dev:lan) on baseUrl (default 13000).
 * Writes: .scratch/pad-labels.png, .scratch/pad-labels-report.json
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(ROOT, ".scratch");
mkdirSync(SCRATCH, { recursive: true });

const BASE = process.argv[2] || "http://127.0.0.1:13000";
const RELAY_PORT = Number(process.env.LABEL_TEST_PORT || 13931);
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const ROOM = "PNP3";
const URL = `${BASE}/match?red=argentina&blue=portugal&play=1&lan=${ROOM}`;
const SHOT = path.join(SCRATCH, "pad-labels.png");
const REPORT = path.join(SCRATCH, "pad-labels-report.json");

const SQUAD = 7;
const N_PHONES = 8;
const AI_FILL = 0x39404d;
const expectPlayerId = (side, n) => (side === "blue" ? SQUAD + n - 1 : n - 1);

const failures = [];
let checks = 0;
function ok(label, cond, extra) {
  checks += 1;
  if (cond) console.log("  \u2713 " + label);
  else {
    failures.push(label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : ""));
    console.log("  \u2717 " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : ""));
  }
}
function eq(label, actual, expected) {
  ok(label + " === " + JSON.stringify(expected), actual === expected, { actual });
}

// ---------------------------------------------------------------------------
// scratch relay
// ---------------------------------------------------------------------------
const relay = spawn(process.execPath, [path.join(ROOT, "script", "lan-server.mjs")], {
  env: { ...process.env, LAN_PORT: String(RELAY_PORT), LAN_IP: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayLog = "";
relay.stdout.on("data", (b) => { relayLog += String(b); if (process.env.VERBOSE) console.error("[relay] " + String(b).trimEnd()); });
relay.stderr.on("data", (b) => { relayLog += String(b); if (process.env.VERBOSE) console.error("[relay:err] " + String(b).trimEnd()); });
relay.on("error", (e) => { relayLog += "spawn error: " + e.message; });
relay.on("exit", (code, sig) => { relayLog += `\nexit code=${code} sig=${sig}`; });

async function stopRelay() {
  if (relay.exitCode === null) {
    try { relay.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}
process.on("exit", () => { try { relay.kill(); } catch {} });

// ---------------------------------------------------------------------------
// fake phones
// ---------------------------------------------------------------------------
function phone(i) {
  const ws = new WebSocket(RELAY);
  const inbox = [];
  const waiters = [];
  let settleOpen = null;
  const opened = new Promise((r) => { settleOpen = r; });
  ws.on("open", () => settleOpen(true));
  ws.on("error", () => settleOpen(false));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    inbox.push(m);
    for (let k = waiters.length - 1; k >= 0; k -= 1) {
      if (waiters[k].pred(m)) {
        const w = waiters.splice(k, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  return {
    i,
    clientId: "label-c" + i,
    ws,
    opened,
    inbox,
    wait(pred, ms = 8000) {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) waiters.splice(k, 1);
          resolve(null);
        }, ms);
        waiters.push(w);
      });
    },
    async join() {
      if (!(await opened)) return null;
      ws.send(JSON.stringify({ t: "join", room: ROOM, name: "P" + i, clientId: "label-c" + i }));
      return this.wait((m) => m.t === "joined" || m.t === "joinErr");
    },
    roster(pred, ms = 8000) {
      return this.wait((m) => m.t === "roster" && (!pred || pred(m)), ms);
    },
    close() { try { ws.close(); } catch {} },
  };
}

const hardTimer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, reason: "hard timeout" }));
  try { relay.kill(); } catch {}
  process.exit(1);
}, 300_000);

const report = { ok: false, url: URL, relay: RELAY };
const phones = [];
let browser = null;

try {
  // --- wait for the scratch relay -----------------------------------------
  {
    let up = false;
    const tryOnce = () =>
      new Promise((resolve) => {
        const probe = new WebSocket(RELAY);
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; try { probe.close(); } catch {} resolve(v); };
        probe.on("open", () => done(true));
        probe.on("error", () => done(false));
        setTimeout(() => done(false), 1500);
      });
    const relayDeadline = Date.now() + 15_000;
    for (;;) {
      up = await tryOnce();
      if (up) break;
      if (relay.exitCode !== null || Date.now() > relayDeadline) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!up) {
      console.error(JSON.stringify({
        ok: false,
        reason: "scratch relay did not start on " + RELAY,
        relayLog: relayLog.slice(-1500),
      }, null, 2));
      process.exit(1);
    }
  }

  browser = await chromium.launch({ channel: "chrome", headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  const failedRequests = [];
  page.on("requestfailed", (r) => {
    failedRequests.push({ url: r.url().slice(0, 200), err: (r.failure() && r.failure().errorText) || "?" });
  });
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text().slice(0, 240));
    if (process.env.VERBOSE) console.error(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  await page.addInitScript((port) => { window.__lanPort = port; }, RELAY_PORT);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const bootDeadline = Date.now() + 90_000;
  for (;;) {
    const p = await Promise.race([
      page.evaluate(() => ({
        mg: !!window.__matchGame,
        st: !!(window.__matchGame && window.__matchGame.stadium),
        lab: !!window.__acLabels,
        cv: !!document.querySelector("canvas"),
      })),
      new Promise((r) => setTimeout(() => r("wedged"), 20_000)),
    ]);
    if (p === "wedged") {
      console.error(JSON.stringify({ ok: false, reason: "wedged — needs headed Chrome" }));
      process.exit(1);
    }
    if (p.mg && p.st && p.lab && p.cv) break;
    if (Date.now() > bootDeadline) {
      console.error(JSON.stringify({ ok: false, reason: "boot stalled", probe: p }));
      process.exit(1);
    }
    await page.waitForTimeout(2_000);
  }

  const playDeadline = Date.now() + 60_000;
  for (;;) {
    const live = await page.evaluate(() => !!(window.__matchGame.pitch && window.__matchGame.pitch.matchStarted));
    if (live || Date.now() > playDeadline) { report.live = live; break; }
    await page.waitForTimeout(1_500);
  }

  // =======================================================================
  console.log("\n### T0: solo regression — no seats means no labels at all");
  // =======================================================================
  const solo = await page.evaluate(() => window.__acLabels.state());
  report.solo = { built: solo.built, shown: solo.shown, layerVisible: solo.layerVisible, itemsVisible: solo.items.filter((i) => i.visible).length };
  eq("no seat -> nothing drawn", solo.items.filter((i) => i.visible).length, 0);
  eq("no seat -> layer hidden", solo.layerVisible, false);

  // =======================================================================
  console.log("\n### joining 8 phones");
  // =======================================================================
  for (let i = 0; i < N_PHONES; i += 1) phones.push(phone(i));
  const joined = await Promise.all(phones.map((p) => p.join()));
  report.joins = joined.map((m) => (m ? { t: m.t, side: m.side, number: m.number, playerId: m.playerId, color: m.color, name: m.name, slot: m.slot } : null));
  ok("all 8 phones got a seat", joined.every((m) => m && m.t === "joined"), report.joins);

  // `roster` is pushed to the HOST (the page), never to the pads, so the
  // authoritative seat list is the one the page builds from it
  await page.waitForFunction(
    (n) => window.__acLanRoster && (window.__acLanRoster.seats || []).length === n,
    N_PHONES,
    { timeout: 20_000 },
  ).catch(() => {});
  const lanRoster = await page.evaluate(() => window.__acLanRoster);
  const lastRoster = { pads: (lanRoster && lanRoster.seats) || [] };
  report.roster = lastRoster.pads;
  eq("the page's roster lists 8 seats", lastRoster.pads.length, N_PHONES);
  ok("all 8 seats are live (none suspended)", lastRoster.pads.every((p) => p.ready !== false),
    lastRoster.pads.map((p) => p.ready));
  ok("the roster carries a colour per seat (the layer paints with it)", lastRoster.pads.every((p) => typeof p.color === "number"),
    lastRoster.pads.map((p) => p.color));

  // let the page publish seats and the layer rebuild + restyle
  await page.waitForFunction(() => (window.__acPads || []).length === 8, null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1_500);

  const st1 = await page.evaluate(() => window.__acLabels.state());
  report.t1 = st1;

  // =======================================================================
  console.log("\n### T1: 14 capsules, one per player, on top of everything");
  // =======================================================================
  eq("14 labels built", st1.built, 14);
  eq("every label found its player's renderer", st1.missingRenderer, 0);
  eq("labels live in stadium.topLayer", st1.parent, "topLayer");
  eq("every label has a renderer at runtime", st1.items.filter((i) => i.hasRenderer).length, 14);
  eq("no build errors", st1.errors.length, 0);
  eq("layer is visible once seats are live", st1.layerVisible, true);

  // numbers: red 1..7, blue 1..7, GK = 1 on both sides
  const nums = { red: {}, blue: {} };
  for (const it of st1.items) nums[it.side][it.playerId] = it.number;
  const redNums = Object.keys(nums.red).map((k) => nums.red[k]).sort((a, b) => a - b);
  const blueNums = Object.keys(nums.blue).map((k) => nums.blue[k]).sort((a, b) => a - b);
  ok("red wears 1..7", JSON.stringify(redNums) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]), redNums);
  ok("blue wears 1..7", JSON.stringify(blueNums) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]), blueNums);
  eq("red GK (playerId 0) is #1", nums.red[0], 1);
  eq("blue GK (playerId 7) is #1", nums.blue[7], 1);

  // numbers must agree with what the relay told each phone
  const bySeat = new Map(st1.items.map((i) => [i.side + ":" + i.playerId, i]));
  const numMismatch = (lastRoster.pads || []).filter((p) => {
    const it = bySeat.get(p.side + ":" + p.playerId);
    return !it || it.number !== p.number;
  });
  ok("every label's number matches the seat the relay handed that phone", numMismatch.length === 0,
    numMismatch.map((p) => ({ side: p.side, padNumber: p.number, labelNumber: bySeat.get(p.side + ":" + p.playerId)?.number })));
  const idMismatch = (lastRoster.pads || []).filter((p) => p.playerId !== expectPlayerId(p.side, p.number));
  ok("every seat's playerId is the side+number mapping the labels invert", idMismatch.length === 0,
    idMismatch.map((p) => ({ side: p.side, number: p.number, playerId: p.playerId, expected: expectPlayerId(p.side, p.number) })));

  // The number above the head must be the number painted on the shirt. The
  // engine bakes the jersey number into the spine skin it applies
  // (`argentina7home`, `portugal3home`, `...1goalkeeper`), so read that straight
  // off the live renderers instead of trusting the seat mapping twice.
  const skins = await page.evaluate(() => {
    const g = window.__matchGame;
    const out = [];
    for (const r of g.stadium.players || []) {
      const p = r.entity || r.player;
      if (!p) continue;
      out.push({
        side: p.team === g.pitch.blueTeam ? "blue" : "red",
        playerId: p.id,
        skin: (r.spine && r.spine.skinName) || "",
      });
    }
    return out;
  });
  report.skins = skins.map((s) => `${s.side}:${s.playerId}=${s.skin}`);
  const skinNumber = (name) => {
    const m = /(\d+)(?:goalkeeper|home|away)$/i.exec(name || "");
    return m ? Number(m[1]) : null;
  };
  eq("all 14 renderers reported a skin", skins.length, 14);
  const shirtBad = skins.filter((s) => {
    const it = bySeat.get(s.side + ":" + s.playerId);
    const n = skinNumber(s.skin);
    return !it || n === null || n !== it.number;
  });
  ok("every label's number is the number on the shirt the engine applies", shirtBad.length === 0,
    shirtBad.map((s) => ({ side: s.side, playerId: s.playerId, skin: s.skin, label: bySeat.get(s.side + ":" + s.playerId)?.number })));
  const skinNums = { red: [], blue: [] };
  for (const s of skins) skinNums[s.side].push(skinNumber(s.skin));
  ok("the shirts themselves read 1..7 on both sides",
    JSON.stringify([...skinNums.red].sort((a, b) => a - b)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7])
    && JSON.stringify([...skinNums.blue].sort((a, b) => a - b)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
    skinNums);

  // =======================================================================
  console.log("\n### T2: humans get their seat colour + nickname, AI stays neutral");
  // =======================================================================
  eq("8 human labels", st1.humans, 8);
  eq("6 AI labels", st1.ai, 6);

  const humanItems = st1.items.filter((i) => i.human);
  const aiItems = st1.items.filter((i) => !i.human);
  const seatByPad = new Map((lastRoster.pads || []).map((p) => [p.side + ":" + p.playerId, p]));

  const colourMismatch = humanItems.filter((it) => {
    const p = seatByPad.get(it.side + ":" + it.playerId);
    return !p || it.fill !== p.color || it.nick !== p.name;
  });
  ok("each human capsule carries its own seat colour and nickname", colourMismatch.length === 0,
    colourMismatch.map((i) => ({ side: i.side, playerId: i.playerId, fill: i.fill, nick: i.nick })));
  eq("8 distinct human colours", new Set(humanItems.map((i) => i.fill)).size, 8);

  // ink must contrast with the capsule fill, not be hardcoded
  const lum = (c) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
  const inkBad = st1.items.filter((i) => (lum(i.fill) > 152 ? i.ink !== 0x101620 : i.ink !== 0xffffff));
  ok("ink is picked from the capsule's own luminance", inkBad.length === 0,
    inkBad.map((i) => ({ fill: i.fill.toString(16), ink: i.ink.toString(16) })));
  ok("at least one seat is bright enough to need dark ink", st1.items.some((i) => i.human && i.ink === 0x101620),
    st1.items.filter((i) => i.human).map((i) => i.fill.toString(16)));

  ok("every AI label is the neutral slate", aiItems.every((i) => i.fill === AI_FILL),
    aiItems.map((i) => i.fill.toString(16)));
  ok("no AI label shows a nickname", aiItems.every((i) => i.nick === ""), aiItems.map((i) => i.nick));

  // =======================================================================
  console.log("\n### T3: geometry — tip above the head, exactly `lift` above the feet");
  // =======================================================================
  const geo = await page.evaluate(() => {
    const R = window.require;
    const G = R("renderers/generic");
    const P2 = R("core/math/point2");
    const g = window.__matchGame;
    const stadium = g.stadium;
    const st = window.__acLabels.state();
    const lift = window.__acLabels.lift();
    const out = P2.create();
    let maxProjErr = 0;
    let maxOffsetErr = 0;
    let maxTipErr = 0;
    let measured = 0;
    const rows = [];
    const rendererOf = (id, side) =>
      (stadium.players || []).find((x) => {
        const e = x.entity || x.player;
        if (!e || e.id !== id) return false;
        return side === "blue" ? e.team === g.pitch.blueTeam : e.team === g.pitch.redTeam;
      });
    for (const item of st.items) {
      if (!item.visible) continue;
      const r = rendererOf(item.playerId, item.side);
      if (!r) continue;
      const player = r.entity || r.player;
      // 1) the label must sit at the renderer's own derived point, exactly
      const spriteY = (r.sprite.position && r.sprite.position.y) || 0;
      maxTipErr = Math.max(maxTipErr, Math.abs(item.tipX - r.position.x));
      maxTipErr = Math.max(maxTipErr, Math.abs(item.tipY - (r.position.y + spriteY - lift)));
      // 2) and that point must be the projection of the player, up to the one
      //    frame the sprite can be behind the simulation (this is the engine's
      //    own render pipeline, not the label layer)
      G.worldToScreenFlat(player.position, out);
      const projErr = Math.hypot(item.feetX - out.x, item.feetY - out.y);
      maxProjErr = Math.max(maxProjErr, projErr);
      maxOffsetErr = Math.max(maxOffsetErr, Math.abs(item.tipY - (item.spriteBaseY - lift)));
      // 3) how tall is this player really, AS PAINTED? Read the RenderTexture
      //    the engine draws the animal into and find its topmost painted row.
      //    This is deliberately NOT the layer's own `lift`: the test recomputes
      //    the height from pixels so a wrong lift cannot validate itself.
      let paintH = null;
      let paintTop = null;
      const rt = r.renderTexture;
      const extract = stadium.game && stadium.game.renderer && stadium.game.renderer.extract;
      if (rt && extract && typeof extract.pixels === "function") {
        try {
          const arr = extract.pixels(rt);
          if (arr && arr.length >= rt.width * rt.height * 4) {
            const W = rt.width;
            const H = rt.height;
            let top = -1;
            for (let y = 0; y < H && top < 0; y += 1) {
              for (let x = 0; x < W; x += 1) if (arr[(y * W + x) * 4 + 3] > 8) { top = y; break; }
            }
            if (top >= 0) {
              const sy = Math.abs((r.sprite.scale && r.sprite.scale.y) || 1);
              paintH = (H - top) * sy; // the sprite is anchored bottom-centre
              paintTop = r.position.y + spriteY - paintH;
              measured += 1;
            }
          }
        } catch (e) {}
      }
      rows.push({
        playerId: item.playerId, side: item.side, number: item.number, human: item.human,
        tipY: +item.tipY.toFixed(2), spriteBaseY: +item.spriteBaseY.toFixed(2),
        projErr: +projErr.toFixed(3), offErr: +Math.abs(item.tipY - (item.spriteBaseY - lift)).toFixed(3),
        paintTop: paintTop == null ? null : +paintTop.toFixed(2),
        paintH: paintH == null ? null : +paintH.toFixed(2),
        gapAboveHead: paintTop == null ? null : +(paintTop - item.tipY).toFixed(2),
      });
    }
    return { lift: +lift.toFixed(2), headMax: st.headMax, rows, maxProjErr: +maxProjErr.toFixed(3), maxOffsetErr: +maxOffsetErr.toFixed(3), maxTipErr: +maxTipErr.toFixed(3), measured };
  });
  report.geo = geo;

  ok("every tip is exactly its computed point (< 0.05 px)", geo.maxTipErr < 0.05, geo.maxTipErr);
  ok("every tip is exactly `lift` above the sprite base (< 0.5 px)", geo.maxOffsetErr < 0.5, geo.maxOffsetErr);
  // one frame of movement at this zoom is a few px, so the bound is a
  // movement bound, not a projection bound — a wrong projection is off by 100s
  ok("every feet point agrees with a fresh worldToScreenFlat (one frame of lag)", geo.maxProjErr < 25, geo.maxProjErr);
  ok("the lift came from a real measurement, not a page-sized guess",
    geo.lift > 25 && geo.lift < 90,
    { lift: geo.lift, headMax: geo.headMax });

  const withPaint = geo.rows.filter((r) => r.paintH != null);
  ok("every label's player was measured from painted pixels", withPaint.length === geo.rows.length,
    { measured: geo.measured, visible: geo.rows.length });
  ok("the painted height is an animal, not an atlas page", withPaint.every((r) => r.paintH > 10 && r.paintH < 80),
    withPaint.map((r) => r.paintH));
  // the whole point of the lift: nothing may overlap the head, and nothing may
  // drift away from it
  const through = withPaint.filter((r) => r.tipY > r.paintTop);
  ok("no tip is drawn through or below the painted head", through.length === 0,
    through.map((r) => ({ playerId: r.playerId, tipY: r.tipY, paintTop: r.paintTop })));
  const adrift = withPaint.filter((r) => r.paintTop - r.tipY > 45);
  ok("no tip floats more than a body-height clear of the head", adrift.length === 0,
    adrift.map((r) => ({ playerId: r.playerId, gapAboveHead: r.gapAboveHead, paintH: r.paintH })));
  report.geo.headroom = withPaint.map((r) => r.gapAboveHead);

  // =======================================================================
  console.log("\n### T4: tracking + culling — follow the camera without drifting");
  // =======================================================================
  const sampleNow = () =>
    page.evaluate(() => {
      const R = window.require;
      const G = R("renderers/generic");
      const P2 = R("core/math/point2");
      const g = window.__matchGame;
      const stadium = g.stadium;
      const cam = P2.create();
      try { stadium.getCameraPosition(cam); } catch (e) {}
      const camW = stadium.cameraWidth || 0;
      const camH = stadium.cameraHeight || 0;
      const out = P2.create();
      const st = window.__acLabels.state();
      const visible = new Set(st.items.filter((i) => i.visible).map((i) => i.side + ":" + i.playerId));
      const inside = [];
      const farOutside = [];
      for (const x of stadium.players || []) {
        const p = x.entity || x.player;
        if (!p || !p.position) continue;
        if (x.visible === false) continue;
        const team = p.team === g.pitch.redTeam ? "red" : "blue";
        G.worldToScreenFlat(p.position, out);
        const inX = out.x >= cam.x && out.x <= cam.x + camW;
        const inY = out.y >= cam.y && out.y <= cam.y + camH;
        const m = 2 * 80; // well beyond any culling margin
        const farX = out.x < cam.x - m || out.x > cam.x + camW + m;
        const farY = out.y < cam.y - m || out.y > cam.y + camH + m;
        const key = team + ":" + p.id;
        if (inX && inY) inside.push(key);
        else if (farX || farY) farOutside.push(key);
      }
      return {
        cam: { x: +cam.x.toFixed(2), y: +cam.y.toFixed(2), w: camW, h: camH },
        visible: [...visible],
        inside,
        farOutside,
        lifts: st.items.filter((i) => i.visible).map((i) => +(i.spriteBaseY - i.tipY).toFixed(2)),
      };
    });

  const samples = [];
  for (let s = 0; s < 4; s += 1) {
    samples.push(await sampleNow());
    await page.waitForTimeout(1_200);
  }
  report.tracking = samples.map((s) => ({ cam: s.cam, visible: s.visible.length, inside: s.inside.length, farOutside: s.farOutside.length }));

  const camMoved = Math.max(...samples.map((s) => Math.hypot(s.cam.x - samples[0].cam.x, s.cam.y - samples[0].cam.y)));
  ok("the camera genuinely moved during the window", camMoved > 20, { camMoved: +camMoved.toFixed(1) });
  // liveness: the engine's follow-camera is tight, so one sample may legitimately
  // hold only 1-2 players. Require every sample to have *something* to judge, and
  // the run as a whole to have put several labels on screen.
  const insideCounts = samples.map((s) => s.inside.length);
  ok("every sample had a player inside the camera to be judged", insideCounts.every((n) => n >= 1), insideCounts);
  ok("the whole window put several labels on screen", insideCounts.reduce((a, b) => a + b, 0) >= 6, insideCounts);

  // culling must be exactly "is it inside the camera rect": nothing on screen
  // may be missing, and nothing far off screen may still be drawn
  const missing = samples.map((s) => s.inside.filter((k) => !s.visible.includes(k)));
  ok("no player inside the camera is missing its label", missing.every((m) => m.length === 0), missing);
  const ghosts = samples.map((s) => s.farOutside.filter((k) => s.visible.includes(k)));
  ok("no player far outside the camera still has a label drawn", ghosts.every((m) => m.length === 0), ghosts);

  const allLifts = samples.flatMap((s) => s.lifts);
  ok("the head offset is identical in every sample (no drift)",
    allLifts.every((v) => Math.abs(v - geo.lift) < 0.6),
    { min: Math.min(...allLifts), max: Math.max(...allLifts), lift: geo.lift });

  await page.screenshot({ path: SHOT, type: "png" });

  // =======================================================================
  console.log("\n### T5: the HUD switch, and the solo 1v1 path staying untouched");
  // =======================================================================
  const off = await page.evaluate(async () => {
    const v = window.__acLabels.set(false);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const st = window.__acLabels.state();
    return { persisted: v, ls: window.localStorage.getItem(window.__acLabels.key), shown: st.shown, layer: st.layerVisible, items: st.items.filter((i) => i.visible).length };
  });
  report.toggleOff = off;
  eq("switching labels off reports off", off.persisted, false);
  eq("the preference is written to localStorage", off.ls, "0");
  eq("nothing is drawn while off", off.items, 0);
  eq("the layer is hidden while off", off.layer, false);
  eq("the shown flag clears while off", off.shown, false);

  const on = await page.evaluate(async () => {
    const v = window.__acLabels.set(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const st = window.__acLabels.state();
    return { persisted: v, ls: window.localStorage.getItem(window.__acLabels.key), shown: st.shown, items: st.items.filter((i) => i.visible).length };
  });
  report.toggleOn = on;
  eq("switching labels back on reports on", on.persisted, true);
  eq("the preference is written back to localStorage", on.ls, "1");
  const afterOn = await sampleNow();
  report.toggleOnCulling = { inside: afterOn.inside.length, visible: afterOn.visible.length };
  ok("the labels come back for everyone inside the camera", afterOn.inside.every((k) => afterOn.visible.includes(k)) && afterOn.inside.length >= 1,
    report.toggleOnCulling);

  // emptying the seat array is exactly what a solo 1v1 match looks like
  const soloAgain = await page.evaluate(async () => {
    const saved = window.__acPads;
    window.__acPads = [];
    await new Promise((r) => setTimeout(r, 400));
    const st = window.__acLabels.state();
    window.__acPads = saved;
    await new Promise((r) => setTimeout(r, 400));
    const back = window.__acLabels.state();
    return {
      gone: { items: st.items.filter((i) => i.visible).length, layer: st.layerVisible, shown: st.shown },
      back: { items: back.items.filter((i) => i.visible).length, layer: back.layerVisible },
    };
  });
  report.soloAgain = soloAgain;
  eq("emptying the seats draws nothing", soloAgain.gone.items, 0);
  eq("emptying the seats hides the layer", soloAgain.gone.layer, false);
  eq("emptying the seats clears the shown flag", soloAgain.gone.shown, false);
  ok("putting the seats back draws the labels again", soloAgain.back.items >= 1, soloAgain.back.items);

  // =======================================================================
  console.log("\n### T6: a phone that drops goes back to looking like AI");
  // =======================================================================
  const victim = phones[0];
  const victimMsg = joined[0];
  victim.close();
  // the relay keeps the seat for 20 s with ready:false, and the page republishes
  // it as `suspended` — that is the moment the capsule must stop looking human
  await page.waitForFunction(
    (pid) => (window.__acPads || []).some((p) => p.padId === pid && p.suspended === true),
    victimMsg.padId,
    { timeout: 20_000 },
  ).catch(() => {});
  await page.waitForTimeout(1_200);
  const dropped = await page.evaluate((pid) => {
    const st = window.__acLabels.state();
    const seat = (window.__acPads || []).find((p) => p.padId === pid);
    const it = st.items.find((i) => i.side === (seat && seat.side) && i.playerId === (seat && seat.playerId));
    return { suspended: !!(seat && seat.suspended), humans: st.humans, ai: st.ai, item: it ? { number: it.number, human: it.human, fill: it.fill, nick: it.nick } : null };
  }, victimMsg.padId);
  report.dropped = dropped;
  eq("the dropped seat is marked suspended on the page", dropped.suspended, true);
  eq("it is no longer counted as a human label", dropped.humans, 7);
  eq("it went back to the AI count", dropped.ai, 7);
  eq("its capsule dropped the nickname", dropped.item && dropped.item.nick, "");
  eq("its capsule went back to the neutral slate", dropped.item && dropped.item.fill, AI_FILL);
  eq("it kept its jersey number", dropped.item && dropped.item.number, victimMsg.number);
  ok("the recovered build reports no errors", (await page.evaluate(() => window.__acLabels.state().errors)).length === 0);

  report.pageErrors = pageErrors;
  report.failedRequests = failedRequests;

  const realErrors = pageErrors.filter((e) => !/favicon|React DevTools|Download the/i.test(e));
  report.pageErrors = realErrors.slice(0, 6);
  eq("page errors", realErrors.length, 0);

  report.ok = failures.length === 0;
  report.checks = checks;
  report.failures = failures;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("\n" + (report.ok ? "ALL PASS" : "FAILURES") + " — " + (checks - failures.length) + "/" + checks);
  console.log("report: " + path.relative(ROOT, REPORT));
  console.log("shot:   " + path.relative(ROOT, SHOT));
} catch (e) {
  report.ok = false;
  report.crash = String((e && e.stack) || e).slice(0, 2000);
  try { writeFileSync(REPORT, JSON.stringify(report, null, 2)); } catch {}
  console.error(JSON.stringify({ ok: false, crash: report.crash }, null, 2));
  console.error("relay log tail:\n" + relayLog.slice(-1500));
} finally {
  clearTimeout(hardTimer);
  for (const p of phones) p.close();
  if (browser) try { await browser.close(); } catch {}
  await stopRelay();
}

if (!report.ok) process.exit(1);
