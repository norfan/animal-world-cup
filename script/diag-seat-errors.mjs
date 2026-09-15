#!/usr/bin/env node
/**
 * Diagnostic (throwaway-ish, kept because this class of bug keeps coming back):
 * load /match with N fake phones, stay silent, and dump the FIRST full stack of
 * any engine error plus the seat driver's own error ledger.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] || "http://127.0.0.1:13000";
const RELAY_PORT = Number(process.env.DIAG_PORT || 13941);
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const ROOM = "DIAG";
const PHONES = Number(process.env.PHONES || 8);
const URL = `${BASE}/match?red=argentina&blue=portugal&play=1&lan=${ROOM}`;

const relay = spawn(process.execPath, [path.join(ROOT, "script", "lan-server.mjs")], {
  env: { ...process.env, LAN_PORT: String(RELAY_PORT), LAN_IP: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", () => {});
relay.stderr.on("data", (b) => process.stderr.write("[relay:err] " + b));
process.on("exit", () => { try { relay.kill(); } catch {} });

const phones = [];
function join(i) {
  const ws = new WebSocket(RELAY);
  ws.on("error", () => {});
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", room: ROOM, name: "D" + i, clientId: "diag-" + i })));
  phones.push(ws);
}

let browser = null;
try {
  await new Promise((r) => setTimeout(r, 1200));

  browser = await chromium.launch({ channel: "chrome", headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const stacks = [];
  page.on("console", (m) => {
    const txt = m.text();
    if (m.type() === "error" && /take control|already controlled/i.test(txt) && stacks.length < 3) {
      stacks.push(txt.slice(0, 4000));
    }
  });
  await page.addInitScript((port) => { window.__lanPort = port; }, RELAY_PORT);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // the page must own the room BEFORE any phone joins, or every join is `no-room`
  await page.waitForFunction(() => !!window.__acLanRoster, null, { timeout: 60_000 }).catch(() => {});
  for (let i = 0; i < PHONES; i += 1) join(i);

  await page.waitForFunction(() => !!(window.__matchGame && window.__matchGame.pitch), null, { timeout: 90_000 }).catch(() => {});
  for (let s = 0; s < 12; s += 1) {
    await page.waitForTimeout(1500);
    if (stacks.length) break;
  }
  const before = stacks.length;

  // replay the exact T5.4 mutation from verify-pad-labels.mjs: empty the seat
  // array for 400 ms, then put it back
  if (process.env.T5 === "1") {
    console.log("=== replaying the empty/restore mutation ===");
    await page.evaluate(async () => {
      const saved = window.__acPads;
      window.__acPads = [];
      await new Promise((r) => setTimeout(r, 400));
      window.__acPads = saved;
      await new Promise((r) => setTimeout(r, 400));
    });
    await page.waitForTimeout(3000);
    console.log("new stacks after the mutation: " + (stacks.length - before));
  }

  const ledger = await page.evaluate(() => {
    const g = window.__matchGame;
    if (!g || !g.pitch) return { fatal: "window.__matchGame.pitch missing", keys: Object.keys(window).filter((k) => k.startsWith("__")).slice(0, 40) };
    return {
      padErrors: (window.__acPadsState && window.__acPadsState.errors) || null,
      padActive: window.__acPadsState && window.__acPadsState.active,
      seats: (window.__acPads || []).length,
      labelErrors: window.__acLabels ? window.__acLabels.state().errors : null,
      users: (function () {
        try {
          const users = window.require("users");
          return users.list.map((u, i) => ({
            i,
            online: u.online,
            enabled: u.enabled,
            locked: !!u.locked,
            team: u.team ? (u.team === g.pitch.redTeam ? "red" : u.team === g.pitch.blueTeam ? "blue" : "other") : null,
            player: u.player ? u.player.id : null,
            connected: !!(u.controller && u.controller.connected),
          }));
        } catch (e) { return String(e && e.message); }
      })(),
      teams: (function () {
        const out = {};
        for (const [name, t] of [["red", g.pitch.redTeam], ["blue", g.pitch.blueTeam]]) {
          out[name] = {
            users: t.users.length,
            players: t.players.length,
            claimed: t.players.map((p) => (p.user ? p.user.id : null)),
          };
        }
        return out;
      })(),
    };
  });
  console.log("=== ledger ===");
  console.log(JSON.stringify(ledger, null, 2));
  console.log("=== first stacks ===");
  for (const s of stacks) console.log("\n---\n" + s);
} catch (e) {
  console.error("DIAG FAILED", e);
} finally {
  for (const p of phones) try { p.close(); } catch {}
  if (browser) try { await browser.close(); } catch {}
  try { relay.kill(); } catch {}
}
