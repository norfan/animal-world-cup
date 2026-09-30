import { spawn } from "node:child_process";
import os from "node:os";

function lanIP() {
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const item of values || []) {
      if (item.family === "IPv4" && !item.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) {
        return item.address;
      }
    }
  }
  return "localhost";
}

const processes = [];

function run(command, args, label, color) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const tag = `\x1b[${color}m[${label}]\x1b[0m `;
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on("data", (buffer) => {
      for (const line of String(buffer).split("\n")) if (line) target.write(tag + line + "\n");
    });
  }
  child.on("exit", (code) => {
    process.stdout.write(tag + `exited (${code})\n`);
    shutdown();
  });
  processes.push(child);
}

function shutdown() {
  for (const child of processes) try { child.kill(); } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("node", ["script/online-server.mjs"], "online", "36");
run("npx", ["next", "dev", "-p", "13000", "-H", "0.0.0.0"], "next", "32");

const ip = lanIP();
console.log("\n\x1b[1m  Animal Cup Online ready\x1b[0m");
console.log("  Local:   http://localhost:13000");
console.log(`  Network: http://${ip}:13000`);
console.log("  Relay:   ws://localhost:13002\n");
