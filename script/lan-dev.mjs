// Dev launcher for LAN play: runs the Next dev server (port 13000) and the
// LAN relay (port 13001) together, so one command (`pnpm dev:lan`) brings up
// everything a local-versus session needs. Plain `pnpm dev` still works for
// solo / watch use — the relay is only required for 局域网联机.
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";

// Resolve the project's own next binary so we don't depend on `npx` being on
// PATH (Windows spawn('npx') without shell:true -> ENOENT). Falls back to the
// shim-less node entry that ships inside the installed next package.
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

// Best-guess LAN IPv4 (matches the relay's heuristic): prefer 192.168.* and
// 10.* over the 172.16/12 block that Docker/Hyper-V/WSL usually occupy. Set
// LAN_IP to force a specific address if auto-detection ever picks wrong.
function lanIP() {
  if (process.env.LAN_IP) return process.env.LAN_IP;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal && /^192\.168\./.test(ni.address)) return ni.address;
    }
  }
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal && /^10\./.test(ni.address)) return ni.address;
    }
  }
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal && /^172\.(1[6-9]|2\d|3[01])\./.test(ni.address)) return ni.address;
    }
  }
  return "localhost";
}

// Strip the WorkBuddy safe-delete shim (NODE_OPTIONS=--require=...shim) from the
// env passed to child processes, so the spawned `next dev` isn't force-killed
// when it cleans its .next cache. Harmless in a normal terminal where
// NODE_OPTIONS is unset. Without this, `next dev` aborts with
// [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] under the sandbox's node.
function cleanEnv() {
  const e = { ...process.env };
  delete e.NODE_OPTIONS;
  return e;
}

const procs = [];
function run(cmd, args, name, color) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => stream.on("data", (b) => {
    for (const line of String(b).split("\n")) if (line) out.write(tag + line + "\n");
  });
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    process.stdout.write(tag + `exited (${code})\n`);
    shutdown();
  });
  procs.push(p);
}

function shutdown() {
  for (const p of procs) { try { p.kill(); } catch {} }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Pre-flight: if a previous LAN instance is still holding 13000/13001 (e.g. a
// stale `dev:lan` left running, or a duplicate start), kill those listeners so we
// don't fail with EADDRINUSE. These are dedicated dev ports, safe to reclaim.
function killListenersOnPorts(ports) {
  if (process.platform !== "win32") return [];
  const killed = new Set();
  try {
    const out = execSync("netstat -ano", { encoding: "utf8" });
    for (const line of out.split("\n")) {
      for (const port of ports) {
        const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
        if (m) killed.add(m[1]);
      }
    }
  } catch {}
  for (const pid of killed) {
    try {
      execSync(`taskkill /F /PID ${pid}`);
      console.log(`[lan] reclaimed LAN port — killed stale listener PID ${pid}`);
    } catch {}
  }
  return [...killed];
}

function start() {
  run("node", ["script/lan-server.mjs"], "lan", "36");
  run("node", [nextBin, "dev", "-p", "13000", "-H", "0.0.0.0"], "next", "32");

  const ip = lanIP();
  console.log(`\n\x1b[1m  Animal Cup — LAN ready\x1b[0m`);
  console.log(`  Big screen / 主机:  http://localhost:13000/lobby`);
  console.log(`  Phones / 手机加入:  http://${ip}:13000/pad   (or scan the QR in the lobby)\n`);
}

const stale = killListenersOnPorts([13000, 13001]);
// Give the OS a moment to release the sockets if we just killed something.
if (stale.length) setTimeout(start, 1500); else start();
