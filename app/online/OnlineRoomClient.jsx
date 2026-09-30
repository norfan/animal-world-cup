"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import LangSwitcher from "../i18n/LangSwitcher";
import { useLocale } from "../i18n/LocaleProvider";
import { FORMATIONS } from "../data/formations";
import { portraitSrc } from "../data/teams";
import {
  canStartOnlineRoom,
  normalizeOnlineConfig,
  normalizeRoomCode,
} from "../../online/shared";
import { createOnlineClient, createOnlineRoom } from "./onlineClient";

const EMPTY_ROSTER = { host: false, screen: false, pads: [] };

function storageKey(role, room) {
  return `animalCupOnline:${role}:${room}`;
}

function formationPayload(config) {
  return {
    red: FORMATIONS.find((item) => item.name === config.formations.red) || FORMATIONS[0],
    blue: FORMATIONS.find((item) => item.name === config.formations.blue) || FORMATIONS[1],
  };
}

function Team({ id, side, t }) {
  return (
    <div className={`or-team or-team--${side}`}>
      <img src={portraitSrc(id)} alt="" />
      <b>{t(`team.${id}.name`)}</b>
    </div>
  );
}

function Seat({ label, ready }) {
  return (
    <div className={`or-seat ${ready ? "is-ready" : ""}`}>
      <span>{label}</span>
      <i aria-hidden />
    </div>
  );
}

export default function OnlineRoomClient({ createMode, initialRoom, initialHost, seed }) {
  const { t } = useLocale();
  const router = useRouter();
  const clientRef = useRef(null);
  const roleRef = useRef(initialHost ? "host" : "screen");
  const roomRef = useRef(normalizeRoomCode(initialRoom));
  const configRef = useRef(null);
  const [status, setStatus] = useState(createMode ? "creating" : "connecting");
  const [room, setRoom] = useState(roomRef.current);
  const [role, setRole] = useState(roleRef.current);
  const [config, setConfig] = useState(null);
  const [roster, setRoster] = useState(EMPTY_ROSTER);
  const [padInvites, setPadInvites] = useState([null, null]);
  const [padQr, setPadQr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState("");

  function enterMatch(nextConfig) {
    const value = normalizeOnlineConfig(nextConfig || configRef.current || seed);
    const code = roomRef.current;
    try {
      sessionStorage.setItem("matchFormations", JSON.stringify(formationPayload(value)));
      sessionStorage.setItem(`animalCupOnline:config:${code}`, JSON.stringify(value));
    } catch {}
    const params = new URLSearchParams({
      red: value.red,
      blue: value.blue,
      ai: String(value.ai),
      side: value.side,
      time: String(value.time),
      squad: String(value.squad || 6),
      play: "1",
      p2: "1",
      online: code,
      onlineRole: roleRef.current === "host" ? "host" : "guest",
      onlineMode: value.mode,
      onlineInput: value.mode === "controllers" ? "pads" : "direct",
    });
    router.push(`/match?${params.toString()}`);
  }

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    let cancelled = false;

    function connect(code, nextRole, token) {
      roleRef.current = nextRole;
      setRole(nextRole);
      let resumeToken = token || "";
      const client = createOnlineClient({
        room: code,
        hello: () => ({ t: "hello", role: nextRole, token: resumeToken }),
        onStatus(next, detail) {
          if (cancelled) return;
          if (next === "connecting") setStatus("connecting");
          if (next === "error") {
            setError(detail || "online-error");
            setStatus("error");
          }
        },
        onMessage(msg) {
          if (cancelled) return;
          if (msg.t === "hosted" || msg.t === "joined") {
            const nextConfig = normalizeOnlineConfig(msg.config || seed);
            resumeToken = msg.token || resumeToken;
            configRef.current = nextConfig;
            setConfig(nextConfig);
            setRoster(msg.roster || EMPTY_ROSTER);
            setPadInvites(msg.padInvites || [null, null]);
            setStatus("ready");
            setError("");
            try { sessionStorage.setItem(storageKey(nextRole, code), resumeToken); } catch {}
            if (msg.started) enterMatch(nextConfig);
          } else if (msg.t === "roster") {
            setRoster(msg.roster || EMPTY_ROSTER);
          } else if (msg.t === "start") {
            enterMatch(msg.config);
          } else if (msg.t === "closed") {
            client.close();
            setError(msg.reason || "host-left");
            setStatus("error");
          } else if (msg.t === "joinErr") {
            client.close();
            setError(msg.reason || "online-error");
            setStatus("error");
          } else if (msg.t === "startErr") {
            setError(msg.reason || "online-error");
            setStatus("error");
          }
        },
      });
      clientRef.current = client;
    }

    async function boot() {
      try {
        if (createMode) {
          const created = await createOnlineRoom({ ...seed, mode: createMode });
          if (cancelled) return;
          const code = normalizeRoomCode(created.room);
          roomRef.current = code;
          setRoom(code);
          setPadInvites(created.padInvites || [null, null]);
          try { sessionStorage.setItem(storageKey("host", code), created.hostToken); } catch {}
          window.history.replaceState(null, "", `/online?room=${code}&host=1`);
          connect(code, "host", created.hostToken);
          return;
        }

        const code = normalizeRoomCode(initialRoom);
        if (code.length !== 6) throw new Error("room");
        roomRef.current = code;
        setRoom(code);
        const nextRole = initialHost ? "host" : "screen";
        const stored = sessionStorage.getItem(storageKey(nextRole, code)) || "";
        if (nextRole === "host" && !stored) throw new Error("host-token");
        connect(code, nextRole, stored);
      } catch (bootError) {
        if (!cancelled) {
          setError(bootError.message || "online-error");
          setStatus("error");
        }
      }
    }

    boot();
    return () => {
      cancelled = true;
      if (clientRef.current) clientRef.current.close();
    };
  }, []);

  const inviteUrl = useMemo(() => {
    if (!origin || !room) return "";
    return `${origin}/online?room=${room}`;
  }, [origin, room]);

  useEffect(() => {
    if (!config || config.mode !== "controllers" || !room || typeof window === "undefined") {
      setPadQr(null);
      return;
    }
    const slot = role === "host" ? 0 : 1;
    const invite = padInvites[slot];
    if (!invite) return setPadQr(null);
    const url = `${window.location.origin}/online-pad?room=${room}&slot=${slot}&invite=${encodeURIComponent(invite)}`;
    QRCode.toDataURL(url, { width: 300, margin: 1, color: { dark: "#24461f", light: "#ffffff" } })
      .then(setPadQr)
      .catch(() => setPadQr(null));
  }, [config, padInvites, role, room]);

  const canStart = role === "host" && canStartOnlineRoom(config, roster);
  const p1 = roster.pads.some((pad) => pad.slot === 0);
  const p2 = roster.pads.some((pad) => pad.slot === 1);
  const errorKey = error ? `online.error.${error}` : "";
  const translatedError = errorKey ? t(errorKey) : "";
  const errorText = translatedError === errorKey ? t("online.error.generic") : translatedError;

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <main className="or">
      <div className="or-pattern" aria-hidden />
      <span className="or-lang"><LangSwitcher /></span>
      <div className="or-wrap">
        <header className="or-head">
          <span className="or-kicker">{config?.mode === "controllers" ? t("online.controllers") : t("online.direct")}</span>
          <h1>{t("online.room")}</h1>
          <div className="or-code">{room || "······"}</div>
          <span className={`or-status or-status--${status}`}>{t(`online.status.${status}`)}</span>
        </header>

        {error ? <div className="or-error">{errorText}</div> : null}

        {config ? (
          <div className="or-versus">
            <Team id={config.red} side="red" t={t} />
            <div className="or-vs">VS</div>
            <Team id={config.blue} side="blue" t={t} />
          </div>
        ) : null}

        <div className="or-grid">
          <section className="or-panel">
            <h2>{role === "host" ? t("online.invite") : t("online.joined")}</h2>
            {role === "host" ? (
              <div className="or-invite">
                <code>{inviteUrl || "..."}</code>
                <button type="button" onClick={copyInvite}>{copied ? t("online.copied") : t("online.copy")}</button>
              </div>
            ) : (
              <p className="or-note">{t("online.waitHost")}</p>
            )}
            <Seat label={t("online.hostScreen")} ready={roster.host} />
            <Seat label={t("online.guestScreen")} ready={roster.screen} />
          </section>

          <section className="or-panel">
            <h2>{config?.mode === "controllers" ? t("online.controllers") : t("online.players")}</h2>
            {config?.mode === "controllers" ? (
              <>
                <div className="or-pad-qr">
                  {padQr ? <img src={padQr} alt="controller QR" /> : <span className="or-qr-wait" />}
                  <b>{role === "host" ? t("online.scanP1") : t("online.scanP2")}</b>
                </div>
                <Seat label="P1" ready={p1} />
                <Seat label="P2" ready={p2} />
              </>
            ) : (
              <>
                <Seat label={t("online.player1")} ready={roster.host} />
                <Seat label={t("online.player2")} ready={roster.screen} />
              </>
            )}
          </section>
        </div>

        <div className="or-actions">
          <button type="button" className="or-btn or-btn--ghost" onClick={() => router.push("/")}>{t("online.back")}</button>
          {role === "host" ? (
            <button type="button" className="or-btn or-btn--start" disabled={!canStart}
                    onClick={() => clientRef.current?.send({ t: "start" })}>
              {t("online.start")}
            </button>
          ) : <span className="or-wait">{t("online.waitHost")}</span>}
        </div>
      </div>
    </main>
  );
}
