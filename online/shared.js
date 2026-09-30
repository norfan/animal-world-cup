export const ONLINE_MODES = ["direct", "controllers"];

export const ONLINE_TEAMS = [
  "england",
  "france",
  "germany",
  "spain",
  "portugal",
  "brazil",
  "argentina",
  "usa",
];

export const ONLINE_FORMATIONS = ["2-3-1", "3-2-1", "2-2-2", "3-1-2", "1-3-2", "2-1-3"];
export const ONLINE_TIMES = [10, 20, 30];
export const ONLINE_AI_LEVELS = [0, 1, 2];
export const ONLINE_SQUADS = [2, 3, 4, 5, 6];
export const ONLINE_ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ONLINE_ROOM_CODE_LENGTH = 6;
export const ONLINE_ROOM_TTL_MS = 30 * 60 * 1000;
export const ONLINE_RECONNECT_GRACE_MS = 30 * 1000;

function oneOf(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

export function normalizeRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ONLINE_ROOM_CODE_LENGTH);
}

export function normalizeOnlineConfig(input = {}) {
  const mode = oneOf(input.mode, ONLINE_MODES, "direct");
  const red = oneOf(input.red, ONLINE_TEAMS, "argentina");
  let blue = oneOf(input.blue, ONLINE_TEAMS, "portugal");
  if (blue === red) blue = ONLINE_TEAMS.find((team) => team !== red) || "portugal";

  const formations = input.formations || {};
  return {
    mode,
    red,
    blue,
    side: input.side === "away" ? "away" : "home",
    ai: oneOf(Number(input.ai), ONLINE_AI_LEVELS, 1),
    time: oneOf(Number(input.time), ONLINE_TIMES, 20),
    squad: oneOf(Number(input.squad), ONLINE_SQUADS, 6),
    formations: {
      red: oneOf(formations.red, ONLINE_FORMATIONS, "2-3-1"),
      blue: oneOf(formations.blue, ONLINE_FORMATIONS, "3-2-1"),
    },
  };
}

function clampAxis(value) {
  const number = Number(value) || 0;
  return Math.max(-1, Math.min(1, number));
}

export function sanitizeOnlineInput(value = {}) {
  return {
    vx: clampAxis(value.vx),
    vy: clampAxis(value.vy),
    shoot: !!value.shoot,
    sprint: !!value.sprint,
    pass: !!value.pass,
    lob: !!value.lob,
    switchPlayer: !!value.switchPlayer,
    tackle: !!value.tackle,
  };
}

export function canStartOnlineRoom(config, roster) {
  if (!config || !roster || !roster.screen) return false;
  if (config.mode === "direct") return true;
  return roster.pads.some((pad) => pad.slot === 0) && roster.pads.some((pad) => pad.slot === 1);
}
