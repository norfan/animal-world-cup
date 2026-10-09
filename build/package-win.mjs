// Builds the Windows desktop bundle for Animal Cup (LAN-first):
//   1. next build with NEXT_OUTPUT=standalone (self-contained server + deps)
//   2. assemble a flat staging dir: standalone server + .next/static + public/
//      + script/lan-server.mjs + ws module + electron shell
//   3. electron-packager -> dist/AnimalCup-win32-x64/
//   4. compress the whole folder to dist/animal-cup-win32-x64.zip
//
// Usage: node build/package-win.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "dist", "animal-cup-stage");
const out = path.join(root, "dist");

const APP_NAME = "AnimalCup";
const ZIP_NAME = "animal-cup-win32-x64.zip";

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function cp(src, dest) { fs.cpSync(src, dest, { recursive: true, dereference: true }); }

async function run(cmd, args, env, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  // spawn directly (no shell): cmd may be process.execPath whose path contains
  // spaces ("User Data\..."), which shell:true would split into two commands.
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit", ...opts });
  const code = await new Promise((res) => p.on("exit", res));
  if (code !== 0) { console.error(`command failed (${code}): ${cmd} ${args.join(" ")}`); process.exit(code || 1); }
}

// ---------------------------------------------------------------- icon ----
await run(process.execPath, ["build/make-icon-win.mjs"], {});

// ------------------------------------------------------- standalone build --
console.log("\n[1/4] next build (standalone output)");
const standalone = path.join(root, ".next", "standalone");
if (process.env.SKIP_NEXT_BUILD !== "1") {
  rmrf(path.join(root, ".next"));
  await run(process.execPath, ["script/safe-build.mjs"], { NEXT_OUTPUT: "standalone" });
} else if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.error("SKIP_NEXT_BUILD=1 but standalone output missing — run without it first");
  process.exit(1);
}
if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.error("standalone server.js missing — build did not produce standalone output");
  process.exit(1);
}
rmrf(stage);
fs.mkdirSync(stage, { recursive: true });

// standalone server + its node_modules
cp(standalone, stage);

// android-pad must stay: /api/apk-meta and /download-apk read
// android-pad/{version.json,animal-cup-pad.apk} at runtime from process.cwd().
// (Next's trace usually carries it into the standalone root, but copy it
// explicitly so the build never silently drops the APK download feature.)
cp(path.join(root, "android-pad"), path.join(stage, "android-pad"));

// static chunks + public assets (server expects them inside its own root)
cp(path.join(root, ".next", "static"), path.join(stage, ".next", "static"));
cp(path.join(root, "public"), path.join(stage, "public"));

// LAN relay + electron shell
cp(path.join(root, "script", "lan-server.mjs"), path.join(stage, "script", "lan-server.mjs"));
cp(path.join(root, "electron"), path.join(stage, "electron"));

// ws is a devDependency here but lan-server.mjs requires it at runtime —
// copy the real (dereferenced) module into the staged node_modules.
const wsReal = fs.realpathSync(require.resolve("ws/package.json", { paths: [root] }));
cp(path.dirname(wsReal), path.join(stage, "node_modules", "ws"));
console.log(`  ws -> ${fs.realpathSync(path.join(stage, "node_modules", "ws", "package.json"))}`);

// minimal package.json for the desktop app
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "animal-cup-desktop",
      productName: "Animal Cup",
      version: "1.0.0",
      description: "AI Animal Football Simulator — LAN local-versus desktop build",
      main: "electron/main.cjs",
      type: "module",
      author: "norfan",
      license: "MIT",
    },
    null,
    2
  )
);

// --------------------------------------------------------------- pack ------
console.log("\n[3/4] electron-packager (win32 x64)");
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")
).version;

const { packager } = await import("@electron/packager");
rmrf(path.join(out, `${APP_NAME}-win32-x64`));
const appPaths = await packager({
  dir: stage,
  name: APP_NAME,
  platform: "win32",
  arch: "x64",
  icon: path.join(root, "build", "icon.ico"),
  out,
  overwrite: true,
  asar: false,
  prune: false,
  electronVersion,
  appVersion: "1.0.0",
  // electron-packager stages the app in the OS temp dir (C:) then renames it
  // into out/ (F:). Cross-volume rename fails with EPERM on Windows, so pin
  // the temp dir to the same volume as the output.
  tmpdir: path.join(out, ".packager-tmp"),
});
console.log("  packed:", appPaths.join(", "));

// ----------------------------------------------------------------- zip ----
console.log("\n[4/4] compressing zip");
const zipPath = path.join(out, ZIP_NAME);
rmrf(zipPath);
await run(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path '${path.join(out, `${APP_NAME}-win32-x64`)}' -DestinationPath '${zipPath}' -Force`],
  {}
);

const sizeMb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`\ndone: ${zipPath} (${sizeMb(zipPath)} MB)`);
console.log(`folder: ${path.join(out, `${APP_NAME}-win32-x64`)} (${sizeMb(path.join(out, `${APP_NAME}-win32-x64`))} MB)`);
