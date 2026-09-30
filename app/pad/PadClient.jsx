"use client";

// Thin client wrapper for the pad route. If the URL carried ?room=XXXX we go
// straight into the gamepad; otherwise we show a 4-char code entry so a phone
// that can't scan the QR can still join by typing the code from the big screen.
import { useEffect, useState } from "react";
import PadController from "./PadController";

// Semver-ish compare: returns -1/0/1. Used to detect an installed APK that's
// older than what /api/apk-meta currently serves.
function cmpVer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export default function PadClient({ room, apk }) {
  const [code, setCode] = useState(room || "");
  const [entered, setEntered] = useState(!!room);
  // The gamepad is a landscape-only surface. On portrait we block the (broken)
  // sideways layout with a "rotate your phone" overlay that clears itself the
  // moment the device is turned — works even as a plain bookmarked shortcut.
  const [isPortrait, setIsPortrait] = useState(false);
  const [dlState, setDlState] = useState("idle"); // idle | downloading | done
  const [showDlBanner, setShowDlBanner] = useState(false);
  const [apkMeta, setApkMeta] = useState(null); // { version, name, size }
  const [hasUpdate, setHasUpdate] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const update = () => setIsPortrait(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Show the download prompt on every visit (the lobby QR opens here), not just
  // the first time. A "不再提示" choice sets ac_apk_banner_done to suppress it
  // for good; the plain × only hides the current one. The auto-download itself
  // only fires once per device (browsers often block non-gesture downloads
  // anyway), so the banner button is the reliable path. Auto-hides after 15s.
  useEffect(() => {
    let suppressed = false;
    try { suppressed = localStorage.getItem("ac_apk_banner_done") === "1"; } catch {}
    if (suppressed) return;
    setShowDlBanner(true);
    let autoDone = false;
    try { autoDone = localStorage.getItem("ac_apk_auto_done") === "1"; } catch {}
    if (!autoDone) {
      try {
        const a = document.createElement("a");
        a.href = "/download-apk";
        a.download = "animal-cup-pad.apk";
        document.body.appendChild(a);
        a.click();
        a.remove();
        try { localStorage.setItem("ac_apk_auto_done", "1"); } catch {}
      } catch {}
    }
    const t = setTimeout(() => setShowDlBanner(false), 15000);
    return () => clearTimeout(t);
  }, []);

  // Pull the current APK metadata so we can show the latest version and warn if
  // this device's installed build (reported via ?apk=) is behind.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/apk-meta")
      .then((r) => r.json())
      .then((m) => {
        if (cancelled) return;
        setApkMeta(m);
        if (apk && m && m.version && cmpVer(apk, m.version) < 0) setHasUpdate(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apk]);

  // Phone-side "download the app" — the lobby QR lands here, so a one-tap
  // download keeps the whole flow on the phone. Triggers an attachment download
  // (server sends Content-Disposition) without navigating away from /pad.
  function handleDownload(e) {
    e.preventDefault();
    if (dlState === "downloading") return;
    setDlState("downloading");
    try {
      const a = document.createElement("a");
      a.href = "/download-apk";
      a.download = "animal-cup-pad.apk";
      document.body.appendChild(a);
      a.click();
      a.remove();
      try { localStorage.setItem("ac_apk_auto_done", "1"); } catch {}
    } catch {}
    setTimeout(() => { setDlState("done"); setShowDlBanner(false); }, 1800);
  }

  function dismissBanner() {
    setShowDlBanner(false);
  }

  function neverShowAgain() {
    setShowDlBanner(false);
    try { localStorage.setItem("ac_apk_banner_done", "1"); } catch {}
  }

  const dlBanner = showDlBanner ? (
    <div className="pad-dl-banner" role="dialog" aria-label="下载手机手柄 App">
      <span className="pad-dl-banner-txt">📱 想用 App 操作？下载手机手柄，横屏全屏更顺手</span>
      <button type="button" className="pad-dl-banner-ignore" onClick={neverShowAgain}>不再提示</button>
      <button type="button" className="pad-dl-banner-btn" onClick={handleDownload}>下载</button>
      <button type="button" className="pad-dl-banner-x" onClick={dismissBanner} aria-label="关闭">×</button>
    </div>
  ) : null;

  const dlInfo = (
    <div className="pad-dl-info" onClick={handleDownload} role="button" aria-label="APK 版本信息">
      {apkMeta
        ? (hasUpdate
            ? `发现新版本 v${apkMeta.version}，点此更新`
            : `最新 v${apkMeta.version}`)
        : "检查版本…"}
    </div>
  );

  const downloadBtn = (
    <>
      <a className="pad-dl" href="/download-apk" onClick={handleDownload} role="button"
         aria-label="下载手机手柄 App">
        <span className="pad-dl-ico" aria-hidden>⬇</span>
        {dlState === "downloading" ? "下载中…" : dlState === "done" ? "已下载 ✓" : "下载手柄 App"}
      </a>
      {dlInfo}
    </>
  );

  if (isPortrait) {
    return (
      <>
        {downloadBtn}
        {dlBanner}
        <div className="pad pad--rotate-hint">
          <div className="rotate-hint">
            <div className="rotate-phone" aria-hidden>
              <svg viewBox="0 0 24 24" width="62" height="62" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
                <line x1="11" y1="18.5" x2="13" y2="18.5" />
              </svg>
              <span className="rotate-arrow" aria-hidden>↻</span>
            </div>
            <b>请横屏使用 · Rotate your phone</b>
            <span>将手机横过来，手柄会自动显示</span>
          </div>
        </div>
      </>
    );
  }

  if (entered && code) {
    return (
      <>
        {downloadBtn}
        {dlBanner}
        <PadController room={code} />
      </>
    );
  }

  return (
    <>
      {downloadBtn}
      {dlBanner}
      <div className="pad pad--status">
        <form
          className="pad-join"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim().length === 4) setEntered(true);
          }}
        >
          <b>输入房间号 · Enter room code</b>
          <input
            className="pad-code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))}
            placeholder="ABCD"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={4}
            aria-label="room code"
          />
          <button type="submit" className="pad-join-btn" disabled={code.trim().length !== 4}>
            加入 · Join
          </button>
        </form>
      </div>
    </>
  );
}
