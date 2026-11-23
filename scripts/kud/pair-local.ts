#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - One-shot setup script run directly by Node.
/* oxlint-disable t3code/no-global-process-runtime -- One-shot setup script with no Effect runtime. */
// Pairs Kud Code with the T3 server official T3 Code runs on ~/.t3: mints a token with
// `t3 pair` and opens it as a `kudcode://pair` link. `--print` only prints the link.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { KUD_IDENTITY } from "@t3tools/shared/kudIdentity";

const printOnly = process.argv.includes("--print");
const t3Home = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
const runtimePath = NodePath.join(t3Home, "userdata", "server-runtime.json");

function fail(message: string): never {
  console.error(`pair-local: ${message}`);
  process.exit(1);
}

let runtime: { pid?: number; origin?: string; port?: number };
try {
  runtime = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8"));
} catch {
  fail(`no running T3 server found (${runtimePath} is missing). Start T3 Code first.`);
}
try {
  if (typeof runtime.pid !== "number") throw new Error("no pid");
  process.kill(runtime.pid, 0);
} catch {
  fail(`the T3 server recorded in ${runtimePath} is not running. Start T3 Code first.`);
}
console.log(`T3 server: ${runtime.origin ?? `port ${runtime.port}`} (pid ${runtime.pid})`);

const bundledShim = NodePath.join(t3Home, "bin", "t3");
const t3 = NodeFS.existsSync(bundledShim) ? bundledShim : "t3";
let output: string;
try {
  output = NodeChildProcess.execFileSync(
    t3,
    ["pair", "--base-dir", t3Home, "--label", KUD_IDENTITY.baseName, "--ttl", "15m"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
} catch {
  fail(`\`${t3} pair\` failed. Install the t3 command from T3 Code's Settings, then retry.`);
}

const pairingUrl = /^Pairing URL: (\S+)$/mu.exec(output)?.[1];
if (!pairingUrl) fail("`t3 pair` printed no pairing URL.");
const appLink = `${KUD_IDENTITY.appLinkScheme}://pair?${new URLSearchParams([["pairingUrl", pairingUrl]])}`;

if (printOnly) {
  console.log(appLink);
  process.exit(0);
}
const opener = process.platform === "darwin" ? "open" : "xdg-open";
NodeChildProcess.execFileSync(opener, [appLink], { stdio: "inherit" });
console.log(
  `Opened ${KUD_IDENTITY.baseName}. Confirm "Add the backend" there; the token expires in 15 minutes.`,
);
