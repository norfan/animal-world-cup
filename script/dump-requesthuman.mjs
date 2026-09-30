// Dump the engine's RequestHuman state + activateAI to see who gets the
// set-piece when the taker is a seated (human) player.
import { readFileSync } from "fs";

const src = readFileSync("public/match-runtime-min/scripts/match.rebuilt.js", "utf8");
const idx = src.indexOf("RequestHuman");
const out = [];
out.push("=== first RequestHuman hit @" + idx + " ===");
if (idx >= 0) out.push(src.substring(idx - 400, idx + 1600));
// find activateAI helper
const ai = src.indexOf("activateAI");
out.push("\n=== first activateAI hit @" + ai + " ===");
if (ai >= 0) out.push(src.substring(ai - 300, ai + 900));
// RequestHuman states list
const list = src.indexOf('"RequestHuman"');
out.push("\n=== states-list RequestHuman @" + list + " ===");
if (list >= 0) out.push(src.substring(list - 300, list + 200));
console.log(out.join("\n"));
