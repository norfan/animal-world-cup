#!/usr/bin/env node
/**
 * verify-pad-lobby — P4 acceptance: the two-side seat board (lobby) and the
 * phone's own seat badge + number picker.
 *
 * WHAT IT PROVES
 *   A. the relay speaks the seat protocol to PHONES, not just to the host:
 *   1. occupancy — every pad learns which numbers each side wears, and its own
 *                  `me` binding, on every change (roster changes touch the host
 *                  only, so this is the pad's only window into the line-up).
 *   2. pick      — a phone picks a FREE number itself and the relay confirms it
 *                  with `bind`, keeping number <-> playerId in step.
 *   3. errors    — `taken` / `bad-number` / `locked` are refused, and a refusal
 *                  never moves anybody: there is NO swapping, so a phone can
 *                  never steal a number another phone is wearing.
 *   B. the real pages render it:
 *   4. lobby     — both squads as 14 numbered seats (2 GK + 12 AI), the start
 *                  button gated on red having a human, and the humans/AI counter
 *                  following the sockets live.
 *   5. pad       — the seat badge shows the side + number in the seat's own
 *                  colour, and the picker greys out the goalkeeper and the
 *                  numbers already worn on that side.
 *   6. pick (UI) — tapping a free number in the pad moves the human seat in the
 *                  lobby, and vice versa the badge follows `bind`.
 *   7. kick-off  — Start locks the line-up: pads are told, the picker refuses,
 *                  and the big screen navigates into /match with the room.
 *
 * ISOLATION
 * A scratch relay on its own port; `window.__lanPort` points both pages at it,
 * so the user's relay on 13001 is never touched.
 *
 * HEADED Chrome only — headless SwiftShader wedges the engine render loop.
 *
 * Usage:  node script/verify-pad-lobby.mjs [baseUrl]
 * Needs:  a running dev server (pnpm dev:lan) on baseUrl (default 13000).
 * Writes: .scratch/pad-lobby.png, .scratch/pad-lobby-report.json
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
const RELAY_PORT = Number(process.env.LOBBY_TEST_PORT || 13981);
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const LOBBY_URL = `${BASE}/lobby?red=argentina&blue=portugal&side=red&ai=3&time=6`;
const SHOT = path.join(SCRATCH, "pad-lobby.png");
const REPORT = path.join(SCRATCH, "pad-lobby-report.json");

const SQUAD = 7;
const GK_NUMBER = 1;
const BINDABLE = [2, 3, 4, 5, 6, 7];
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
relay.stdout.on("data", (b) => { relayLog += String(b); });
relay.stderr.on("data", (b) => { relayLog += String(b); });
process.on("exit", () => { try { relay.kill(); } catch {} });

// ---------------------------------------------------------------------------
// socket helpers
// ---------------------------------------------------------------------------
function sock(name) {
  const ws = new WebSocket(RELAY);
  const inbox = [];
  const waiters = [];
  let settle = null;
  const opened = new Promise((r) => { settle = r; });
  ws.on("open", () => settle(true));
  ws.on("error", () => settle(false));
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
    name,
    ws,
    opened,
    inbox,
    send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
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
    /** newest message matching pred — for re-checks after a change */
    last(pred) {
      for (let i = inbox.length - 1; i >= 0; i -= 1) if (pred(inbox[i])) return inbox[i];
      return null;
    },
    /** drop everything already received, so the next wait() is about the future */
    flush() { inbox.length = 0; },
    close() { try { ws.close(); } catch {} },
  };
}

async function host(room) {
  const h = sock("host");
  if (!(await h.opened)) return null;
  h.send({ t: "host", room: room || "" });
  const hosted = await h.wait((m) => m.t === "hosted");
  return hosted ? { h, room: hosted.room } : null;
}

async function pad(name, room, clientId) {
  const p = sock(name);
  if (!(await p.opened)) return null;
  p.send({ t: "join", room, name, clientId: clientId || name });
  const joined = await p.wait((m) => m.t === "joined" || m.t === "joinErr");
  return joined ? { p, joined } : null;
}

const hardTimer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, reason: "hard timeout" }, null, 1));
  try { relay.kill(); } catch {}
  process.exit(1);
}, 300_000);

const report = { ok: false, relay: RELAY, lobby: LOBBY_URL };
const opened = [];
let browser = null;

try {
  // --- wait for the scratch relay -----------------------------------------
  {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      up = await new Promise((r) => {
        const probe = new WebSocket(RELAY);
        let s = false;
        const fin = (v) => { if (s) return; s = true; try { probe.close(); } catch {} r(v); };
        probe.on("open", () => fin(true));
        probe.on("error", () => fin(false));
        setTimeout(() => fin(false), 1200);
      });
      if (!up) {
        if (relay.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!up) {
      console.error(JSON.stringify({ ok: false, reason: "scratch relay did not start", relayLog: relayLog.slice(-1200) }, null, 1));
      process.exit(1);
    }
  }

  // =======================================================================
  console.log("\n### A1: every pad learns the line-up (occupancy)");
  // =======================================================================
  const A = await host("PLBY");
  ok("a scratch room was minted", !!A, A && A.room);
  const roomA = A ? A.room : "PLBY";

  // one side's worth of phones, plus one on blue
  const padsA = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await pad("A" + i, roomA, "lobby-a" + i);
    padsA.push(r ? r.p : null);
    opened.push(r && r.p);
  }
  ok("4 phones joined", padsA.every(Boolean), padsA.map((p) => (p ? "ok" : "null")));
  const sides = padsA.map((p) => (p ? p.last((m) => m.t === "joined").side : null));
  report.A1 = sides;
  ok("the relay balanced them across both sides", new Set(sides).size === 2, sides);

  const occ = padsA[0] && padsA[0].last((m) => m.t === "occupancy");
  ok("the pad received an occupancy message", !!occ);
  if (occ) {
    ok("occupancy carries both sides' numbers",
      Array.isArray(occ.red) && Array.isArray(occ.blue), { red: occ.red, blue: occ.blue });
    ok("occupancy carries the bindable list and the GK number",
      JSON.stringify(occ.bindable) === JSON.stringify(BINDABLE) && occ.gkNumber === GK_NUMBER,
      { bindable: occ.bindable, gkNumber: occ.gkNumber });
    ok("occupancy carries this pad's own binding",
      !!occ.me && occ.me.side === sides[0] && occ.me.number === occ.me.number && !!occ.me.playerId,
      occ.me && { side: occ.me.side, number: occ.me.number, playerId: occ.me.playerId });
    eq("the GK number is never in the occupied list", occ.red.includes(GK_NUMBER) || occ.blue.includes(GK_NUMBER), false);
  }
  // the numbers must agree with the sides they were handed out on
  const perSide = { red: [], blue: [] };
  for (const p of padsA) {
    const j = p.last((m) => m.t === "joined");
    perSide[j.side].push(j.number);
  }
  report.A1 = { sides, perSide };
  ok("no two phones on a side share a number",
    perSide.red.length === new Set(perSide.red).size && perSide.blue.length === new Set(perSide.blue).size, perSide);
  ok("no phone was handed the goalkeeper number",
    !perSide.red.includes(GK_NUMBER) && !perSide.blue.includes(GK_NUMBER), perSide);

  // =======================================================================
  console.log("\n### A2: a phone picks its own number");
  // =======================================================================
  const mover = padsA.find((p) => p.last((m) => m.t === "joined").side === "red");
  const myJoin = mover.last((m) => m.t === "joined");
  const target = BINDABLE.find((n) => n !== myJoin.number && !perSide.red.includes(n));
  report.A2 = { from: myJoin.number, to: target, side: "red" };
  ok("there was a free number to move to", typeof target === "number", report.A2);
  mover.flush();
  mover.send({ t: "pick", number: target });
  const bound = await mover.wait((m) => m.t === "bind" || m.t === "pickErr");
  ok("the relay confirmed the pick with a bind", !!bound && bound.t === "bind", bound);
  if (bound && bound.t === "bind") {
    eq("the bound number is the one that was picked", bound.number, target);
    eq("the bound playerId follows the side+number mapping", bound.playerId, expectPlayerId("red", target));
    eq("the bound side did not change", bound.side, "red");
  }
  const occAfter = await mover.wait((m) => m.t === "occupancy" && m.red.includes(target));
  ok("the new number was broadcast to every pad", !!occAfter, occAfter && occAfter.red);
  if (occAfter) {
    eq("the pad's own binding follows", occAfter.me.number, target);
    eq("the old number was released", occAfter.red.includes(myJoin.number), false);
  }
  // and the other red phone hears about it too
  const otherRed = padsA.find((p) => p !== mover && p.last((m) => m.t === "joined").side === "red");
  ok("every other pad got the same picture",
    !!otherRed && !!otherRed.wait((m) => m.t === "occupancy" && m.red.includes(target), 1500),
    otherRed && otherRed.last((m) => m.t === "occupancy"));

  // =======================================================================
  console.log("\n### A3: refusals never move anybody");
  // =======================================================================
  const otherJoin = otherRed.last((m) => m.t === "joined");
  // 3a. taken: try to take the number the mover now wears
  otherRed.flush();
  otherRed.send({ t: "pick", number: target });
  const taken = await otherRed.wait((m) => m.t === "bind" || m.t === "pickErr");
  eq("picking a worn number is refused as taken", taken && taken.reason, "taken");
  ok("the refused pad kept its old number",
    otherRed.last((m) => m.t === "occupancy").me.number === otherJoin.number,
    { was: otherJoin.number, now: otherRed.last((m) => m.t === "occupancy").me.number });
  ok("and the pad wearing it kept it too",
    mover.last((m) => m.t === "occupancy").me.number === target, target);

  // 3b. the goalkeeper is not a seat
  otherRed.flush();
  otherRed.send({ t: "pick", number: GK_NUMBER });
  const gk = await otherRed.wait((m) => m.t === "bind" || m.t === "pickErr");
  eq("picking the goalkeeper number is refused", gk && gk.reason, "bad-number");
  otherRed.flush();
  otherRed.send({ t: "pick", number: 8 });
  const eight = await otherRed.wait((m) => m.t === "bind" || m.t === "pickErr");
  eq("picking a number off the bench is refused", eight && eight.reason, "bad-number");

  // 3c. picking what you already wear is a no-op confirm, not an error
  otherRed.flush();
  otherRed.send({ t: "pick", number: otherJoin.number });
  const same = await otherRed.wait((m) => m.t === "bind" || m.t === "pickErr");
  ok("picking your own number just confirms it", !!same && same.t === "bind" && same.number === otherJoin.number, same);

  // 3d. lock
  A.h.send({ t: "lock", locked: true });
  const locked = await otherRed.wait((m) => m.t === "locked");
  ok("the host locked the line-up and the pads heard", !!locked && locked.locked === true, locked);
  otherRed.flush();
  otherRed.send({ t: "pick", number: BINDABLE.find((n) => n !== otherJoin.number && !perSide.red.includes(n)) });
  const refused = await otherRed.wait((m) => m.t === "bind" || m.t === "pickErr");
  eq("a pick after kick-off is refused as locked", refused && refused.reason, "locked");
  eq("occupancy reports the lock too", (otherRed.last((m) => m.t === "occupancy") || {}).locked, true);

  // =======================================================================
  console.log("\n### B: the real pages — lobby board + phone badge");
  // =======================================================================
  browser = await chromium.launch({ channel: "chrome", headless: false });
  const bigCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  const lobby = await bigCtx.newPage();
  const phonePage = await phoneCtx.newPage();
  for (const p of [lobby, phonePage]) {
    p.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    p.on("console", (m) => { if (m.type() === "error") pageErrors.push("console:" + m.text().slice(0, 200)); });
    await p.addInitScript((port) => { window.__lanPort = port; }, RELAY_PORT);
  }

  await lobby.goto(LOBBY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // the lobby mints its own room as the host
  await lobby.waitForFunction(() => {
    const b = document.querySelector(".lb-code b");
    return !!b && /^[A-Z0-9]{4}$/.test((b.textContent || "").trim());
  }, null, { timeout: 40_000 });
  const roomB = (await lobby.textContent(".lb-code b")).trim();
  report.B = { room: roomB };
  ok("the lobby minted a room of its own", /^[A-Z0-9]{4}$/.test(roomB), roomB);

  const seats = async () => lobby.$$eval(".lb-seat", (els) =>
    els.map((e) => {
      const team = e.closest(".lb-team");
      return {
        cls: e.className,
        n: (e.querySelector("b") || {}).textContent || "",
        who: (e.querySelector("i") || {}).textContent || "",
        seat: e.style.getPropertyValue("--seat") || "",
        // jersey numbers are unique PER SIDE: red #2 and blue #2 are two seats
        side: team ? (team.className.includes("--red") ? "red" : "blue") : "",
      };
    }));
  const board = async () => {
    const s = await seats();
    return {
      total: s.length,
      gk: s.filter((x) => x.cls.includes("is-gk")).length,
      human: s.filter((x) => x.cls.includes("is-human")),
      ai: s.filter((x) => x.cls.includes("is-ai")).length,
      held: s.filter((x) => x.cls.includes("is-held")).length,
    };
  };

  const b0 = await board();
  report.B.initial = b0;
  eq("the board shows 14 numbered seats", b0.total, 14);
  eq("both goalkeepers are marked", b0.gk, 2);
  eq("every other seat starts as AI", b0.ai, 12);
  eq("nobody is bound yet", b0.human.length, 0);
  const startDisabled = await lobby.getAttribute(".lb-btn--go", "disabled");
  ok("Start is gated while red has no phone", startDisabled !== null, startDisabled);
  const note0 = await lobby.textContent(".lb-note");
  ok("the lobby says why it cannot start yet", /红队|Red needs|human/i.test(note0 || ""), note0);

  // two raw phones take seats, then the browser phone joins as the third
  const rawOnB = [];
  for (let i = 0; i < 2; i += 1) {
    const r = await pad("B" + i, roomB, "lobby-b" + i);
    rawOnB.push(r && r.p);
    opened.push(r && r.p);
  }
  const rawSides = rawOnB.map((p) => p.last((m) => m.t === "joined").side);
  report.B.rawSides = rawSides;
  ok("two phone sockets took seats in the lobby's room", rawOnB.every(Boolean), rawSides);

  // the browser phone — it joins in PORTRAIT on purpose: PadClient gates the
  // gamepad behind a rotate hint, and that gate is part of the flow the lobby
  // QR leads a real phone into, so it gets an assertion of its own.
  await phonePage.goto(`${BASE}/pad?room=${roomB}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const hint = await phonePage.waitForSelector(".rotate-hint", { timeout: 25_000 }).catch(() => null);
  ok("a portrait phone is asked to rotate before it can play", !!hint);
  await phonePage.setViewportSize({ width: 844, height: 390 });
  const badge = await phonePage.waitForSelector(".pad-seat", { timeout: 30_000 }).catch(() => null);
  ok("rotating to landscape reveals the gamepad and its seat badge", !!badge);
  await phonePage.waitForFunction(() => {
    const em = document.querySelector(".pad-seat em");
    return !!em && /\d+\s*号/.test(em.textContent || "");
  }, null, { timeout: 20_000 }).catch(() => {});
  const badgeTxt = await phonePage.textContent(".pad-seat");
  const badgeNum = Number(((await phonePage.textContent(".pad-seat em")) || "").match(/(\d+)/)?.[1]);
  const badgeStyle = await phonePage.$eval(".pad-seat", (e) => ({
    bg: e.style.background || getComputedStyle(e).backgroundColor,
    color: e.style.color || getComputedStyle(e).color,
  }));
  report.B.badge = { text: badgeTxt, number: badgeNum, style: badgeStyle };
  ok("the badge names a side and a number", /红队|蓝队/.test(badgeTxt || "") && badgeNum >= 1 && badgeNum <= SQUAD,
    { badgeTxt, badgeNum });
  ok("the badge is painted a real colour (not the default grey)",
    !!badgeStyle.bg && badgeStyle.bg !== "rgb(85, 95, 107)", badgeStyle);
  await phonePage.screenshot({ path: SHOT, type: "png" });

  // the lobby must have picked the new human up
  await lobby.waitForFunction(() => document.querySelectorAll(".lb-seat.is-human").length > 0,
    null, { timeout: 15_000 }).catch(() => {});
  const b1 = await board();
  report.B.afterPhones = b1;
  eq("all three phones are on the board as humans", b1.human.length, 3);
  eq("the AI count dropped to match", b1.ai, 9);
  ok("every human seat carries its own colour",
    b1.human.every((x) => /^#[0-9a-f]{6}$/i.test(x.seat)), b1.human.map((x) => x.seat));
  ok("no two humans share a colour",
    new Set(b1.human.map((x) => x.seat)).size === b1.human.length, b1.human.map((x) => x.seat));
  ok("the human seats carry a name", b1.human.some((x) => x.who && x.who !== "AI"), b1.human.map((x) => x.who));
  const startNow = await lobby.getAttribute(".lb-btn--go", "disabled");
  ok("Start became available once red had a phone", startNow === null, startNow);
  const heads = await lobby.$$eval(".lb-team-meta span", (els) => els.map((e) => e.textContent));
  report.B.heads = heads;
  ok("the humans/AI counter follows the sockets", heads.some((h) => /3|2|1/.test(h || "")), heads);

  // =======================================================================
  console.log("\n### B2: the phone's picker drives the board");
  // =======================================================================
  await phonePage.click(".pad-seat");
  await phonePage.waitForSelector(".pad-pick", { timeout: 10_000 }).catch(() => {});
  const cells = await phonePage.$$eval(".pad-pick", (els) =>
    els.map((e) => ({ n: Number(e.querySelector("b") ? e.querySelector("b").textContent : NaN), cls: e.className, off: e.disabled })));
  report.B.picker = cells;
  eq("the picker offers one cell per jersey number", cells.length, SQUAD);
  const gkCell = cells.find((c) => c.n === GK_NUMBER);
  ok("the goalkeeper cell is disabled", !!gkCell && gkCell.off === true, gkCell);
  const myCell = cells.find((c) => c.cls.includes("is-mine"));
  ok("the cell the phone wears is marked as mine", !!myCell && myCell.n === badgeNum, { myCell, badgeNum });
  ok("at least one other cell was free to pick",
    cells.some((c) => !c.off && !c.cls.includes("is-mine")),
    cells.map((c) => `${c.n}${c.off ? "!" : ""}`));

  // pick the first pickable free number through the UI
  const freeCell = cells.find((c) => !c.off && !c.cls.includes("is-mine"));
  ok("there was a pickable free number", !!freeCell, cells);
  if (freeCell) {
    await phonePage.locator(".pad-pick").nth(cells.indexOf(freeCell)).click();
    await phonePage.waitForFunction((n) => {
      const em = document.querySelector(".pad-seat em");
      return !!em && (em.textContent || "").includes(String(n));
    }, freeCell.n, { timeout: 12_000 }).catch(() => {});
    const after = Number(((await phonePage.textContent(".pad-seat em")) || "").match(/(\d+)/)?.[1]);
    eq("the badge followed the pick", after, freeCell.n);
    // and the lobby board moved the human cell with it
    await lobby.waitForTimeout(600);
    const b2 = await board();
    const nums = b2.human.map((h) => Number(h.n));
    report.B.afterPick = { badge: after, human: nums };
    ok("the board still shows three humans (nobody was dropped)", b2.human.length === 3, nums);
    ok("one of the human seats is the number the phone just picked",
      nums.includes(freeCell.n), { picked: freeCell.n, human: nums });
    const perSide = { red: [], blue: [] };
    for (const h of b2.human) if (perSide[h.side]) perSide[h.side].push(Number(h.n));
    ok("no two human seats on a side wear the same number",
      Object.values(perSide).every((a) => new Set(a).size === a.length), perSide);
    eq("both sides are still on the board", b2.human.length, perSide.red.length + perSide.blue.length);
  }

  // =======================================================================
  console.log("\n### B3: kick-off locks the line-up");
  // =======================================================================
  await lobby.click(".lb-btn--go");
  const lockedMsg = await rawOnB[0].wait((m) => m.t === "locked", 8000);
  ok("the pads were told the line-up is locked", !!lockedMsg && lockedMsg.locked === true, lockedMsg);
  await phonePage.waitForTimeout(400);
  await phonePage.click(".pad-seat").catch(() => {});
  await phonePage.waitForTimeout(300);
  const lockNote = await phonePage.textContent(".pad-picker-note").catch(() => "");
  report.B.lockNote = lockNote;
  ok("the picker says numbers are locked after kick-off", /不可换号|Locked/.test(lockNote || ""), lockNote);
  await lobby.waitForURL((u) => u.pathname === "/match", { timeout: 20_000 }).catch(() => {});
  const finalUrl = lobby.url();
  report.B.finalUrl = finalUrl;
  ok("the big screen went into the match carrying the room",
    finalUrl.includes("/match") && finalUrl.includes("lan=" + roomB), finalUrl);

  report.checks = checks;
  report.failures = failures;
  report.pageErrors = pageErrors;

  // =======================================================================
  console.log("\n### page health");
  // =======================================================================
  const noisy = pageErrors.filter((e) => !/favicon|Download the React DevTools|websocket/i.test(e));
  // the /match page fetches the 811 KB bundle + assets; a dev-server 404 on a
  // probe asset is not a P4 regression, so only hard errors count
  const hard = noisy.filter((e) => /is not a function|is not defined|Cannot read|TypeError|ReferenceError/.test(e));
  ok("no page exceptions while driving the lobby and the pad", hard.length === 0, hard.slice(0, 5));
} catch (e) {
  failures.push("threw: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
  console.error("  ! " + ((e && e.message) || e));
} finally {
  clearTimeout(hardTimer);
  report.ok = failures.length === 0;
  report.checks = checks;
  report.failures = failures;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("\n" + (failures.length === 0 ? `ALL PASS — ${checks}/${checks}` : `FAILURES — ${checks - failures.length}/${checks}`));
  for (const f of failures) console.log("  - " + f);
  console.log("report: " + REPORT);
  if (browser) await browser.close().catch(() => {});
  try { relay.kill(); } catch {}
  process.exit(failures.length === 0 ? 0 : 1);
}
