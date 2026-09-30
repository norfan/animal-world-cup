// Find every occurrence of "RequestHuman" + the l() mapping helper in the
// engine bundle, so we can see what the referee hands the taker.
import { readFileSync } from "fs";

const src = readFileSync("public/match-runtime-min/scripts/match.rebuilt.js", "utf8");
const out = [];
// all occurrences of RequestHuman (excluding the state defs already seen)
let i = -1;
let n = 0;
while ((i = src.indexOf("RequestHuman", i + 1)) >= 0) {
  n += 1;
  if (n > 40) break;
  const seg = src.substring(Math.max(0, i - 160), i + 160);
  out.push(`--- #[${n}] @${i} ---\n${seg}`);
}
out.push("\n=== total hits: " + n + " ===");
// the l() mapping helper near RequestHuman def (search 'var l=' right before RequestHuman area or generic)
const li = src.indexOf("var l=");
out.push("\n=== var l= @" + li + " ===");
if (li >= 0) out.push(src.substring(li, li + 700));
console.log(out.join("\n"));
