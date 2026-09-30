import { WebSocket } from "ws";

const base = (process.argv[2] || "http://127.0.0.1:13002").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const origin = process.env.ONLINE_TEST_ORIGIN || "http://localhost:13000";

async function create(config) {
  const response = await fetch(`${base}/create`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ config }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`create failed: ${JSON.stringify(data)}`);
  return data;
}

function connect(room, hello) {
  const socket = new WebSocket(`${wsBase}/connect?room=${room}`, { origin });
  const queue = [];
  const waiters = [];

  function publish(value) {
    const index = waiters.findIndex((waiter) => waiter.predicate(value));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else {
      queue.push(value);
    }
  }

  socket.on("message", (data, binary) => {
    if (binary) publish({ binary: true, data: Buffer.from(data) });
    else {
      try { publish(JSON.parse(String(data))); } catch {}
    }
  });

  const opened = new Promise((resolve, reject) => {
    socket.once("open", () => {
      socket.send(JSON.stringify(hello));
      resolve();
    });
    socket.once("error", reject);
  });

  return {
    socket,
    opened,
    send(value) { socket.send(JSON.stringify(value)); },
    sendBinary(value) { socket.send(value); },
    waitFor(predicate, timeout = 3000) {
      const queued = queue.findIndex(predicate);
      if (queued >= 0) return Promise.resolve(queue.splice(queued, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("socket message timeout"));
        }, timeout);
        waiters.push(waiter);
      });
    },
    close() { try { socket.close(); } catch {} },
  };
}

const isType = (type) => (value) => !value.binary && value.t === type;
const clients = [];
const extraChecks = [];

try {
  const missing = connect("ZZZZZZ", { t: "hello", role: "screen" });
  clients.push(missing);
  await missing.opened;
  const missingError = await missing.waitFor(isType("joinErr"));
  if (missingError.reason !== "no-room") throw new Error("missing room error mismatch");

  const direct = await create({
    mode: "direct",
    red: "argentina",
    blue: "portugal",
    formations: { red: "2-3-1", blue: "3-2-1" },
  });
  const directHost = connect(direct.room, { t: "hello", role: "host", token: direct.hostToken });
  const directGuest = connect(direct.room, { t: "hello", role: "screen" });
  clients.push(directHost, directGuest);
  await Promise.all([directHost.opened, directGuest.opened]);
  const [, directJoined] = await Promise.all([
    directHost.waitFor(isType("hosted")),
    directGuest.waitFor(isType("joined")),
  ]);
  const directRoster = await directHost.waitFor((msg) => msg.t === "roster" && msg.roster.screen);
  if (!directRoster.roster.host) throw new Error("direct host missing from roster");

  directGuest.close();
  await directHost.waitFor((msg) => msg.t === "roster" && !msg.roster.screen);
  const resumedGuest = connect(direct.room, {
    t: "hello", role: "screen", token: directJoined.token,
  });
  clients.push(resumedGuest);
  await resumedGuest.opened;
  await resumedGuest.waitFor(isType("joined"));
  await directHost.waitFor((msg) => msg.t === "roster" && msg.roster.screen);

  directHost.send({ t: "start" });
  await Promise.all([directHost.waitFor(isType("start")), resumedGuest.waitFor(isType("start"))]);
  resumedGuest.send({ t: "input", seq: 1, d: { vx: 0.5, vy: -0.25, pass: true } });
  const directInput = await directHost.waitFor(isType("input"));
  if (directInput.slot !== 1 || directInput.d.vx !== 0.5 || !directInput.d.pass) throw new Error("direct input mismatch");

  const frame = Buffer.from([0xac, 1, 2, 3, 4, 5]);
  directHost.sendBinary(frame);
  const relayedFrame = await resumedGuest.waitFor((msg) => msg.binary);
  if (!relayedFrame.data.equals(frame)) throw new Error("binary frame mismatch");
  resumedGuest.send({ t: "rematchRequest" });
  await directHost.waitFor(isType("rematchRequest"));

  const controllers = await create({ mode: "controllers", red: "england", blue: "france" });
  const padHost = connect(controllers.room, { t: "hello", role: "host", token: controllers.hostToken });
  const padScreen = connect(controllers.room, { t: "hello", role: "screen" });
  const pad0 = connect(controllers.room, {
    t: "hello", role: "pad", slot: 0, invite: controllers.padInvites[0],
  });
  const pad1 = connect(controllers.room, {
    t: "hello", role: "pad", slot: 1, invite: controllers.padInvites[1],
  });
  clients.push(padHost, padScreen, pad0, pad1);
  await Promise.all([padHost.opened, padScreen.opened, pad0.opened, pad1.opened]);
  const [, , , pad1Joined] = await Promise.all([
    padHost.waitFor(isType("hosted")),
    padScreen.waitFor(isType("joined")),
    pad0.waitFor(isType("joined")),
    pad1.waitFor(isType("joined")),
  ]);
  await padHost.waitFor((msg) => msg.t === "roster" && msg.roster.screen && msg.roster.pads.length === 2);
  padHost.send({ t: "start" });
  await Promise.all([
    padHost.waitFor(isType("start")),
    padScreen.waitFor(isType("start")),
    pad0.waitFor(isType("start")),
    pad1.waitFor(isType("start")),
  ]);
  pad1.close();
  await padHost.waitFor((msg) => msg.t === "roster" && !msg.roster.pads.some((pad) => pad.slot === 1));
  const resumedPad1 = connect(controllers.room, {
    t: "hello", role: "pad", slot: 1, token: pad1Joined.token,
  });
  clients.push(resumedPad1);
  await resumedPad1.opened;
  const resumedPadJoined = await resumedPad1.waitFor(isType("joined"));
  if (!resumedPadJoined.started) throw new Error("resumed controller did not receive active match state");
  await padHost.waitFor((msg) => msg.t === "roster" && msg.roster.pads.some((pad) => pad.slot === 1));

  resumedPad1.send({ t: "input", seq: 1, d: { vx: -1, vy: 0.25, shoot: true } });
  const padInput = await padHost.waitFor((msg) => msg.t === "input" && msg.slot === 1);
  if (padInput.d.vx !== -1 || !padInput.d.shoot) throw new Error("pad input mismatch");
  padHost.send({ t: "ended", detail: { red: "england", blue: "france", score: [1, 0] } });
  await Promise.all([
    padScreen.waitFor(isType("ended")),
    pad0.waitFor(isType("ended")),
    resumedPad1.waitFor(isType("ended")),
  ]);

  if (process.env.ONLINE_TEST_HOST_CLOSE === "1") {
    const hostCloseRoom = await create({ mode: "direct" });
    const closingHost = connect(hostCloseRoom.room, {
      t: "hello", role: "host", token: hostCloseRoom.hostToken,
    });
    const waitingGuest = connect(hostCloseRoom.room, { t: "hello", role: "screen" });
    clients.push(closingHost, waitingGuest);
    await Promise.all([closingHost.opened, waitingGuest.opened]);
    await Promise.all([closingHost.waitFor(isType("hosted")), waitingGuest.waitFor(isType("joined"))]);
    closingHost.close();
    const closed = await waitingGuest.waitFor(isType("closed"), 55_000);
    if (closed.reason !== "host-left") throw new Error("host close reason mismatch");
    extraChecks.push("host reconnect grace expiry");
  }

  console.log(JSON.stringify({
    ok: true,
    directRoom: direct.room,
    controllerRoom: controllers.room,
    checks: [
      "missing room terminal error",
      "direct host/guest roster",
      "direct guest token resume",
      "direct start and input relay",
      "binary frame relay",
      "guest rematch request",
      "controller screen and P1/P2 joins",
      "controller resume during active match",
      "controller start/input/end broadcasts",
      ...extraChecks,
    ],
  }, null, 2));
} finally {
  for (const client of clients) client.close();
}
