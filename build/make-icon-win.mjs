// Renders the game's existing 512px app icon into build/icon.ico for Windows
// packaging (PNG-compressed ICO entries, supported by Vista+ and electron-packager).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "public", "icon-512.png");
const outDir = path.join(root, "build");
const sizes = [256, 64, 48, 32, 16];

if (!fs.existsSync(src)) {
  console.error(`missing source icon: ${src}`);
  process.exit(1);
}

const pngs = [];
for (const s of sizes) {
  pngs.push(await sharp(src).resize(s, s, { fit: "cover" }).png().toBuffer());
}

// ---- ICO container (ICONDIR + ICONDIRENTRY[] + payloads) ----
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);            // reserved
header.writeUInt16LE(1, 2);            // type = icon
header.writeUInt16LE(count, 4);        // image count

let offset = 6 + 16 * count;
const entries = [];
for (let i = 0; i < count; i++) {
  const e = Buffer.alloc(16);
  const s = sizes[i];
  e.writeUInt8(s >= 256 ? 0 : s, 0);   // width (0 = 256)
  e.writeUInt8(s >= 256 ? 0 : s, 1);   // height (0 = 256)
  e.writeUInt8(0, 2);                  // colour palette
  e.writeUInt8(0, 3);                  // reserved
  e.writeUInt16LE(1, 4);               // colour planes
  e.writeUInt16LE(32, 6);              // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8);  // payload size
  e.writeUInt32LE(offset, 12);         // payload offset
  offset += pngs[i].length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...pngs]);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon.ico"), ico);
console.log(`wrote build/icon.ico (${ico.length} bytes, sizes ${sizes.join("/")})`);
