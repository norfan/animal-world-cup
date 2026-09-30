// Cross-platform `rm -rf` replacement for package.json scripts.
// Usage: node script/rmrf.mjs <path> [<path> ...]
// Windows cmd has no `rm`, and PowerShell aliases `rm` to Remove-Item with
// different semantics — this keeps every script portable across shells.
import { rmSync } from "node:fs";

for (const target of process.argv.slice(2)) {
  try {
    rmSync(target, { recursive: true, force: true });
    console.log(`[rmrf] removed ${target}`);
  } catch (err) {
    console.error(`[rmrf] failed to remove ${target}: ${err.message}`);
    process.exitCode = 1;
  }
}
