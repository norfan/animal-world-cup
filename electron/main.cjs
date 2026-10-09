// Electron shell for Animal Cup (desktop, LAN-first).
//
// On launch it starts the two servers the LAN mode needs and opens the big
// screen in a native window:
//   1. Next.js production server  ->  http://0.0.0.0:13000  (game pages, QR codes)
//   2. LAN relay                  ->  ws://0.0.0.0:13001     (phone pads)
// Phones on the same Wi-Fi scan the QR on the lobby page and play as pads;
// no separate install, no Node.js needed on the host (Electron ships its own
// runtime and child processes run in ELECTRON_RUN_AS_NODE mode).
const { app, BrowserWindow, Menu } = require("electron");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 13000;
const LAN_PORT = 13001;
const READY_TIMEOUT_MS = 60_000;

const logFile = () => path.join(app.getPath("userData"), "server.log");

function log(line) {
  try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`); } catch {}
}

// ---------------------------------------------------------------------------
// Port pre-flight: reclaim stale listeners on our two ports (a crashed or
// duplicate instance that left its servers behind). These are dedicated game
// ports, so killing a leftover listener is safe.
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
  } catch (e) { log(`netstat failed: ${e.message}`); }
  for (const pid of killed) {
    try { execSync(`taskkill /F /T /PID ${pid}`); log(`reclaimed stale listener PID ${pid} on LAN ports`); } catch {}
  }
  return [...killed];
}

// ---------------------------------------------------------------------------
// Child servers, spawned with Electron's own Node runtime.
const children = [];

function runServer(scriptRel, args, name, extraEnv = {}) {
  const script = path.join(ROOT, scriptRel);
  const p = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const tag = `[${name}] `;
  p.stdout.on("data", (b) => { for (const l of String(b).split("\n")) if (l) log(tag + l); });
  p.stderr.on("data", (b) => { for (const l of String(b).split("\n")) if (l) log(tag + l); });
  p.on("exit", (code, sig) => log(`${name} exited (code=${code} sig=${sig})`));
  children.push(p);
  return p;
}

function killChildren() {
  for (const p of children) {
    try {
      if (process.platform === "win32") execSync(`taskkill /F /T /PID ${p.pid}`);
      else p.kill("SIGTERM");
    } catch {}
  }
}

async function waitReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Window
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Animal Cup",
    backgroundColor: "#0e141a",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.maximize();
  win.once("ready-to-show", () => win.show());

  // The game owns its own in-page fullscreen; outbound links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    require("electron").shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

function buildMenu(win) {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "退出", accelerator: "Alt+F4", click: () => app.quit() },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "切换全屏", accelerator: "F11", click: () => win.setFullScreen(!win.isFullScreen()) },
        { label: "开发者工具", accelerator: "Ctrl+Shift+I", click: () => win.webContents.toggleDevTools() },
        { label: "重新加载", accelerator: "Ctrl+R", click: () => win.webContents.reload() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(async () => {
    log(`Animal Cup desktop starting (root=${ROOT})`);
    killListenersOnPorts([PORT, LAN_PORT]);

    // 1) Next.js production server (standalone build — server.js sits at the
    //    app root, with .next/static + public/ beside it inside resources/app).
    //    Port/host go through env: the standalone server honours PORT/HOSTNAME
    //    (its own CLI ignores -p/-H and would fall back to :3000).
    runServer("server.js", [], "next", { PORT: String(PORT), HOSTNAME: "0.0.0.0" });
    // 2) LAN relay (defaults to LAN_PORT; LAN_IP auto-detected inside the script).
    runServer(path.join("script", "lan-server.mjs"), [], "lan");

    const win = createWindow();
    buildMenu(win);

    const target = `http://127.0.0.1:${PORT}`;
    const ready = await waitReady(`${target}/api/health`, READY_TIMEOUT_MS);
    if (ready) {
      win.loadURL(target);
    } else {
      const errPath = logFile();
      win.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            `<body style="background:#0e141a;color:#eee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
               <div style="text-align:center;max-width:520px">
                 <h2>Animal Cup 启动失败</h2>
                 <p>本地服务器 ${PORT}/${LAN_PORT} 在 ${READY_TIMEOUT_MS / 1000}s 内没有就绪。</p>
                 <p style="font-size:13px;color:#999">日志文件：<code>${errPath}</code></p>
               </div>
             </body>`
          )
      );
    }

    win.on("closed", () => app.quit());
  });

  app.on("will-quit", () => {
    killChildren();
  });

  app.on("window-all-closed", () => app.quit());
}
