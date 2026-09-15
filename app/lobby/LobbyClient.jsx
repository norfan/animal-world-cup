"use client";

// LAN lobby (big screen). Reached from the Landing once both teams are chosen,
// carrying ?red=&blue=&side=&ai= . It:
//   1. connects to the relay as host -> gets a room code + the host LAN IP
//   2. shows a QR + join URL + the code so phones can open /pad?room=XXXX
//   3. shows both squads as 7 numbered seats, filling in as phones join: a seat
//      turns into a human the moment a pad claims it, and goes back to AI when
//      that pad drops
//   4. on Start: locks the line-up (a phone may still take a FREE seat, but
//      nobody can change the number they were handed), tells the pads to begin,
//      then navigates the big screen into /match?...&play=1&p2=1&lan=ROOM
//
// The relay room survives this lobby -> match navigation via the server's host
// grace timer, so the phones stay connected straight through kickoff.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useLocale } from "../i18n/LocaleProvider";
import LangSwitcher from "../i18n/LangSwitcher";
import { portraitSrc, runtimeHeadSrc } from "../data/teams";
import { createLanClient } from "../lan/lanClient";

function Portrait({ id }) {
  return (
    <span className="lb-pp">
      <img src={portraitSrc(id)} alt="" onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = runtimeHeadSrc(id); }} />
    </span>
  );
}

export default function LobbyClient({ red, blue, side, ai, time }) {
  const { t } = useLocale();
  const router = useRouter();
  const [room, setRoom] = useState(null);
  const [join, setJoin] = useState(null); // full http URL the phone opens
  const [qr, setQr] = useState(null); // data URL
  const [apkQr, setApkQr] = useState(null); // data URL for the app-download QR
  const [apkUrl, setApkUrl] = useState(null); // full http URL to /download-apk
  const [pads, setPads] = useState([]); // [{padId,name,slot,ready,side,number,playerId,color}]
  const [counts, setCounts] = useState(null); // { red:{humans,ai}, blue:{humans,ai} }
  const lanRef = useRef(null);

  useEffect(() => {
    const lan = createLanClient({
      onMessage(msg) {
        if (msg.t === "hosted") {
          setRoom(msg.room);
          const url = `http://${msg.ip}:${msg.port}/pad?room=${msg.room}`;
          setJoin(url);
          QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: "#1d3d16", light: "#ffffff" } })
            .then(setQr)
            .catch(() => setQr(null));
          // A second QR lets a phone download the controller app straight from
          // the big screen — no need to hunt for the button inside /pad.
          const apk = `http://${msg.ip}:${msg.port}/download-apk`;
          setApkUrl(apk);
          QRCode.toDataURL(apk, { margin: 1, width: 160, color: { dark: "#1d3d16", light: "#ffffff" } })
            .then(setApkQr)
            .catch(() => setApkQr(null));
        } else if (msg.t === "roster") {
          setPads(msg.pads || []);
          if (msg.counts) setCounts(msg.counts);
        }
      },
    });
    lanRef.current = lan;
    // no room yet -> the relay mints one and replies `hosted`
    lan.setHello(() => ({ t: "host", room: "" }));
    return () => lan.close();
  }, []);

  const redHumans = counts ? counts.red.humans : pads.filter((p) => p.side === "red").length;
  const canStart = redHumans >= 1; // the red side needs at least one human to play

  function start() {
    if (!room || !canStart) return;
    // Kick-off locks the line-up: after this a phone may still take a FREE seat,
    // but nobody can change the number they were handed. `ended` unlocks again.
    lanRef.current && lanRef.current.send({ t: "lock", locked: true });
    // tell the pads to switch to LIVE, then drive the big screen into the match;
    // the relay's host grace timer keeps the room (and the phones) alive across
    // this navigation. Formations are left to the engine's random roll.
    lanRef.current && lanRef.current.send({ t: "start", info: { red, blue } });
    const url = `/match?red=${red}&blue=${blue}&ai=${ai}&side=${side}&time=${time}&play=1&p2=1&lan=${room}`;
    router.push(url);
  }

  return (
    <main className="lb">
      <div className="lb-pattern" aria-hidden />
      <span className="lb-lang"><LangSwitcher /></span>

      <div className="lb-wrap">
        <h1 className="lb-title">{t("lan.title")}</h1>
        <p className="lb-sub">{t("lan.sub")}</p>

        <div className="lb-cols">
          {/* left: scan-to-join */}
          <section className="lb-card lb-join">
            <h2 className="lb-h2">{t("lan.scan")}</h2>
            <div className="lb-qr">
              {qr ? <img src={qr} alt="join QR" /> : <div className="lb-qr-wait" />}
            </div>
            <div className="lb-code">
              <span className="lb-code-label">{t("lan.code")}</span>
              <b>{room || "····"}</b>
            </div>
            {join ? <code className="lb-url">{join}</code> : null}
            <p className="lb-hint">{t("lan.hint")}</p>

            <div className="lb-apk">
              <div className="lb-apk-qr">
                {apkQr ? <img src={apkQr} alt="download app QR" /> : <div className="lb-qr-wait" />}
              </div>
              <div className="lb-apk-meta">
                <b>扫码下载手机手柄 App</b>
                <span>Scan to download the controller app (APK)</span>
                {apkUrl ? <code className="lb-url">{apkUrl}</code> : null}
              </div>
            </div>
          </section>

          {/* right: who's in — both squads, seat by seat */}
          <section className="lb-card lb-squads">
            <h2 className="lb-h2">{t("lan.players")}</h2>
            <TeamSeats teamId={red} tone="red" side="red" pads={pads} counts={counts} t={t} />
            <TeamSeats teamId={blue} tone="blue" side="blue" pads={pads} counts={counts} t={t} />
            <p className="lb-note">{redHumans ? t("lan.noteReady") : t("lan.noteNoRed")}</p>
          </section>
        </div>

        <div className="lb-actions">
          <button type="button" className="lb-btn lb-btn--ghost" onClick={() => router.push("/")}>
            {t("lan.back")}
          </button>
          <button type="button" className="lb-btn lb-btn--go" disabled={!canStart} onClick={start}>
            {t("lan.start")}
          </button>
        </div>
      </div>
    </main>
  );
}

/** One side of the 7-seat board: GK is always AI, #2..#7 are human or AI. */
function TeamSeats({ teamId, tone, side, pads, counts, t }) {
  const mine = pads.filter((p) => p.side === side);
  const byNumber = new Map(mine.map((p) => [p.number, p]));
  const humans = counts && counts[side] ? counts[side].humans : mine.length;
  const aiCount = counts && counts[side] ? counts[side].ai : 7 - humans;
  return (
    <div className={`lb-team lb-team--${tone}`}>
      <div className="lb-team-head">
        <Portrait id={teamId} />
        <div className="lb-team-meta">
          <b>{t(`team.${teamId}.name`)}</b>
          <span>{t("lan.humansAI").replace("{h}", String(humans)).replace("{a}", String(aiCount))}</span>
        </div>
      </div>
      <div className="lb-seats">
        {[1, 2, 3, 4, 5, 6, 7].map((n) => {
          const pad = byNumber.get(n) || null;
          const gk = n === 1;
          const held = !!pad && pad.ready === false;
          const cls = `lb-seat ${pad ? "is-human" : gk ? "is-gk" : "is-ai"} ${held ? "is-held" : ""}`;
          const style = pad && typeof pad.color === "number"
            ? { "--seat": `#${(pad.color >>> 0).toString(16).padStart(6, "0")}` }
            : undefined;
          return (
            <span key={n} className={cls} style={style}
                  title={pad ? `${pad.name || "Pad"} · ${n}` : `${n} · ${gk ? t("lan.gk") : "AI"}`}>
              <b>{n}</b>
              <i>{gk ? t("lan.gk") : pad ? (pad.name || "P").slice(0, 6) : "AI"}</i>
            </span>
          );
        })}
      </div>
    </div>
  );
}
