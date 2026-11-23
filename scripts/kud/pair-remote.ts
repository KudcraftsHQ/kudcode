#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - One-shot setup script run directly by Node.
/* oxlint-disable t3code/no-global-process-runtime -- One-shot setup script with no Effect runtime. */
// Usage: pair-remote.ts --ssh <user@host> --origin <https://host:port> [--label <name>] [--print]
// Runs the remote's active-runtime `t3 pair` over SSH, swaps the pairing URL's origin for --origin
// (how this machine reaches that server), and opens it as a `kudcode://pair` link.
// `--print` prints the link instead; otherwise the token is never printed.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import { KUD_IDENTITY } from "@t3tools/shared/kudIdentity";

function fail(message: string): never {
  console.error(`pair-remote: ${message}`);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  return value;
}

const sshTarget = flag("--ssh");
const originArg = flag("--origin");
const printOnly = process.argv.includes("--print");
if (!sshTarget || !originArg) {
  fail(
    "usage: pair-remote.ts --ssh <user@host> --origin <https://host:port> [--label <name>] [--print]",
  );
}
let origin: string;
try {
  origin = new URL(originArg).origin;
} catch {
  fail(`--origin ${originArg} is not a URL.`);
}
const shortHost = NodeOS.hostname().split(".")[0] ?? "this machine";
const label = flag("--label") ?? `${KUD_IDENTITY.baseName} · ${shortHost}`;

const reachable = NodeChildProcess.spawnSync(
  "curl",
  ["-fsS", "-m", "10", "-o", "/dev/null", `${origin}/.well-known/t3/environment`],
  { stdio: ["ignore", "ignore", "inherit"] },
);
if (reachable.status !== 0) fail(`${origin} does not answer as a T3 server from this machine.`);

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const remoteScript = [
  "set -e",
  `state="$HOME/.t3/runtime/service-state.json"`,
  `version=$(sed -n 's/.*"activeVersion"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$state" | head -n1)`,
  `[ -n "$version" ] || { echo "no activeVersion in $state" >&2; exit 3; }`,
  `exec "$HOME/.t3/runtime/versions/$version/t3" pair --label ${quote(label)} --ttl 15m`,
].join("\n");

let output: string;
try {
  output = NodeChildProcess.execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshTarget, "sh", "-c", quote(remoteScript)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
} catch {
  fail(`\`t3 pair\` over SSH to ${sshTarget} failed.`);
}

const printed = /^Pairing URL: (\S+)$/mu.exec(output)?.[1];
if (!printed) fail("`t3 pair` printed no pairing URL.");
const remoteUrl = new URL(printed);
const pairingUrl = `${origin}${remoteUrl.pathname}${remoteUrl.search}${remoteUrl.hash}`;
const appLink = `${KUD_IDENTITY.appLinkScheme}://pair?${new URLSearchParams([["pairingUrl", pairingUrl]])}`;

if (printOnly) {
  console.log(appLink);
  process.exit(0);
}
const opener = process.platform === "darwin" ? "open" : "xdg-open";
NodeChildProcess.execFileSync(opener, [appLink], { stdio: "inherit" });
console.log(
  `Opened ${KUD_IDENTITY.baseName} for ${origin}. Confirm "Add the backend" there; the token expires in 15 minutes.`,
);
