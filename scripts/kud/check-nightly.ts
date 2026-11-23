#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off extendsNativeError:off - a synchronous git/vp driver run from a terminal, outside any Effect runtime.
// Exit 0 and print the tag when upstream has a nightly newer than Kud Code's base, else exit 3.
// Usage: node scripts/kud/check-nightly.ts [--main <branch>] [--no-fetch] [--notify <ntfy topic>]

import * as NodeUtil from "node:util";

import {
  compareNightly,
  git,
  gitOk,
  localNightlyTags,
  newestNightly,
  notify,
  parseNightlyTag,
  readBase,
  remoteNightlyTags,
} from "./lib.ts";

const { values } = NodeUtil.parseArgs({
  allowNegative: true,
  options: {
    main: { type: "string", default: "main" },
    fetch: { type: "boolean", default: true },
    notify: { type: "string" },
  },
});

if (values.fetch) {
  git(["fetch", "--quiet", "origin", values.main], { allowFail: true });
  git(["fetch", "--quiet", "--tags", "upstream"]);
}
const ref = gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${values.main}`])
  ? `origin/${values.main}`
  : values.main;
const base = parseNightlyTag(readBase(ref).tag);
const newest = newestNightly(values.fetch ? remoteNightlyTags("upstream") : localNightlyTags());

if (!base || !newest || compareNightly(newest, base) <= 0) {
  console.error(`No nightly newer than ${base?.tag ?? "the base"}.`);
  process.exit(3);
}

console.log(newest.tag);
notify(
  values.notify,
  `Kud Code: ${newest.tag} is out`,
  `Base is ${base.tag}. On the Mac: node scripts/kud/update.ts --agent --build mac --install`,
);
