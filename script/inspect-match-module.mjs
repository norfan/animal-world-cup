#!/usr/bin/env node
/**
 * inspect-match-module — read the source of the pre-built match engine.
 *
 * WHY THIS EXISTS
 * The engine's original source (`match-runtime-source/`, and the
 * `script/build-match-runtime*.mjs` pipeline that produced it) was gitignored
 * from the very first commit and no longer exists on any disk. What we ship is
 * `public/match-runtime-min/scripts/match.rebuilt.js`: a single-line, 811 KB,
 * 142-module AMD bundle with no source map.
 *
 * That bundle is still perfectly readable — every module is a literal
 * `define("<name>", function(){ ... })`. This tool splits the bundle on those
 * top-level `define(` calls and prints the requested modules, so nobody has to
 * reverse-engineer engine behaviour from symptoms again.
 *
 * It is READ-ONLY over an artefact we already ship; it never touches network or
 * git and it does not reconstruct or redistribute anything new.
 *
 * USAGE
 *   node script/inspect-match-module.mjs --list
 *   node script/inspect-match-module.mjs players/states team users
 *   node script/inspect-match-module.mjs --grep states.update
 *   node script/inspect-match-module.mjs --out ./tmp players/states   # write files
 *
 * Module bodies are minified; `--pretty` (default on for a single module) runs a
 * deliberately crude re-indenter that is good enough to read a state machine.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(HERE, "..", "public", "match-runtime-min", "scripts", "match.rebuilt.js");

if (!fs.existsSync(BUNDLE)) {
  console.error("bundle not found: " + BUNDLE);
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : null;
};
const has = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};

const outDir = flag("--out");
const grepNeedle = flag("--grep");
const wantList = has("--list");
const wantRaw = has("--raw");
const pretty = !wantRaw;
const wanted = argv;

// ---------------------------------------------------------------------------
// Split the bundle on its top-level `define("<name>", ...)` calls.
// ---------------------------------------------------------------------------
const src = fs.readFileSync(BUNDLE, "utf8");

/** @type {Map<string, string>} module name -> minified factory body */
const modules = new Map();
{
  const marks = [];
  const re = /define\("/g;
  let m;
  while ((m = re.exec(src))) marks.push(m.index);
  for (let i = 0; i < marks.length; i += 1) {
    const chunk = src.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : src.length);
    const nameEnd = chunk.indexOf('"', 8);
    if (nameEnd < 0) continue;
    const name = chunk.slice(8, nameEnd);
    // drop `define("name",` and a leading `(function(` / `function(`
    const body = chunk.slice(nameEnd + 1).replace(/^\s*,\s*\(?\s*function\s*\(/, "");
    modules.set(name, body);
  }
}

const names = [...modules.keys()].sort();

function finish(code) {
  // The last chunk of the bundle runs to EOF, so trim the trailing `))` / `);`.
  return code.replace(/\s*\)\)?;?\s*$/, "");
}

/**
 * Deliberately crude re-indenter. It handles string and regex literals so it
 * does not break on `;`/`{` inside them, which is all a minified bundle needs.
 */
function beautify(code) {
  let out = "";
  let indent = 0;
  let prev = "";
  const PRE = "([,=:[!&|?{};+-*%~^<>";
  const nl = () => {
    out = out.replace(/[ \t]+$/, "");
    out += "\n" + "  ".repeat(Math.max(0, indent));
  };
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") j += 2;
        else if (code[j] === c) break;
        else j += 1;
      }
      out += code.slice(i, j + 1);
      prev = '"';
      i = j + 1;
      continue;
    }
    if (c === "/" && prev && PRE.includes(prev)) {
      let j = i + 1;
      let cls = false;
      for (; j < code.length; j += 1) {
        if (code[j] === "\\") j += 1;
        else if (code[j] === "[") cls = true;
        else if (code[j] === "]") cls = false;
        else if (code[j] === "/" && !cls) break;
      }
      out += code.slice(i, j + 1);
      prev = "/";
      i = j + 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === " ") {
      if (!/\s$/.test(out)) out += " ";
      i += 1;
      continue;
    }
    if (c === "{") {
      out += "{";
      indent += 1;
      nl();
      prev = "{";
      i += 1;
      continue;
    }
    if (c === "}") {
      indent -= 1;
      out = out.replace(/[ \t]+$/, "");
      if (!/[;,{]$/.test(out.replace(/\s+$/, ""))) out += "\n" + "  ".repeat(Math.max(0, indent));
      out += "}";
      prev = "}";
      i += 1;
      continue;
    }
    if (c === ";" || c === ",") {
      out += c;
      nl();
      prev = c;
      i += 1;
      continue;
    }
    out += c;
    prev = c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
if (wantList || (!wanted.length && !grepNeedle)) {
  console.log(modules.size + " modules in " + path.relative(process.cwd(), BUNDLE) + ":\n");
  console.log(names.join("\n"));
  if (wantList) process.exit(0);
}

if (grepNeedle) {
  const re = new RegExp(grepNeedle);
  let hits = 0;
  for (const n of names) {
    const body = modules.get(n);
    if (!re.test(body)) continue;
    hits += 1;
    console.log("\n### " + n);
    const lines = finish(body).split(";");
    for (const line of lines) if (re.test(line)) console.log("  " + line.slice(0, 400));
  }
  console.log("\n" + hits + " module(s) matched " + grepNeedle);
  process.exit(0);
}

let found = 0;
for (const w of wanted) {
  const exact = modules.has(w);
  const hits = exact ? [w] : names.filter((n) => n.includes(w));
  if (!hits.length) {
    console.error("! no module matches " + JSON.stringify(w));
    continue;
  }
  for (const n of hits) {
    found += 1;
    const body = finish(modules.get(n));
    const text = pretty ? beautify(body) : body;
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const p = path.join(outDir, n.replace(/\//g, "_") + (pretty ? ".pretty.js" : ".min.js"));
      fs.writeFileSync(p, text, "utf8");
      console.log("wrote " + p + "  (" + body.length + " -> " + text.length + " chars)");
    } else {
      console.log("\n" + "#".repeat(96));
      console.log("# MODULE: " + n + "  (" + body.length + " chars)");
      console.log("#".repeat(96));
      console.log(text);
    }
  }
}
if (!found) process.exit(1);
