#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off extendsNativeError:off - a synchronous git/vp driver run from a terminal, outside any Effect runtime.
// Lists the upstream files the Kud commits change and rewrites docs/kudcode/PATCHES.md.
// Usage: node scripts/kud/patches.ts [--ref <ref>] [--base <tag>] [--check]

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { PATCHES_FILE, REPO_ROOT, git, hasCommand, readBase, run } from "./lib.ts";

const KUD_ONLY = [
  /^apps\/web\/src\/kud\//,
  /^scripts\/kud\//,
  /^docs\/kudcode\//,
  /^\.github\/workflows\/kud-/,
];
export const GENERATED = [
  /^apps\/web\/src\/routeTree\.gen\.ts$/,
  /^apps\/(web|mobile)\/src\/i18n\/translations\/[^/]+\.json$/,
  /^pnpm-lock\.yaml$/,
];
const GENERATED_WHY = "Generated; regenerated on every update, never hand-merged.";

interface Patch {
  readonly file: string;
  readonly added: number;
  readonly removed: number;
  readonly why: string;
}

function existingWhy(): Map<string, string> {
  const why = new Map<string, string>();
  let text = "";
  try {
    text = NodeFS.readFileSync(NodePath.join(REPO_ROOT, PATCHES_FILE), "utf8");
  } catch {
    return why;
  }
  for (const line of text.split("\n")) {
    const match = /^\|\s*`(.+?)`\s*\|(.*)\|([^|]*)\|\s*$/.exec(line);
    if (match?.[1] && match[2]?.trim()) why.set(match[1], match[2].trim());
  }
  return why;
}

export function collectPatches(ref: string, base: string): Patch[] {
  const upstreamFiles = new Set(git(["ls-tree", "-r", "--name-only", base]).split("\n"));
  const known = existingWhy();
  const numstat = git(["diff", "--numstat", "--no-renames", base, ref]);
  return numstat
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [added = "0", removed = "0", file = ""] = line.split("\t");
      if (!upstreamFiles.has(file) || KUD_ONLY.some((pattern) => pattern.test(file))) return [];
      const generated = GENERATED.some((pattern) => pattern.test(file));
      const subjects = [
        ...new Set(
          git(["log", "--reverse", "--format=%s", `${base}..${ref}`, "--", file]).split("\n"),
        ),
      ].filter(Boolean);
      const why =
        known.get(file) ??
        (generated
          ? GENERATED_WHY
          : subjects.slice(0, 2).join("; ").replaceAll("|", "\\|") || "TODO");
      return [
        {
          file,
          added: added === "-" ? 0 : Number(added),
          removed: removed === "-" ? 0 : Number(removed),
          why,
        },
      ];
    });
}

export function renderPatches(base: string, patches: ReadonlyArray<Patch>): string {
  const rows = patches.map(
    (patch) => `| \`${patch.file}\` | ${patch.why} | +${patch.added} -${patch.removed} |`,
  );
  const total = patches.reduce((sum, patch) => sum + patch.added + patch.removed, 0);
  return [
    "# Kud Code: upstream patches",
    "",
    `Upstream files the Kud commits change, against \`${base}\`. Written by \`node scripts/kud/patches.ts\`,`,
    "which `scripts/kud/update.ts` runs after every update. Edit the Why column by hand; the rest is",
    "rewritten. Files that only exist in Kud Code (`apps/web/src/kud/**`, `scripts/kud/**`,",
    "`docs/kudcode/**`) are not listed.",
    "",
    ...(rows.length === 0
      ? ["No upstream files are patched yet."]
      : [
          "| File | Why | Lines |",
          "| --- | --- | --- |",
          ...rows,
          "",
          `${patches.length} files, ${total} changed lines.`,
        ]),
    "",
  ].join("\n");
}

export function writePatches(ref: string, base: string): ReadonlyArray<Patch> {
  const file = NodePath.join(REPO_ROOT, PATCHES_FILE);
  const patches = collectPatches(ref, base);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, renderPatches(base, patches));
  if (hasCommand("vp")) run("vp", ["fmt", "--no-error-on-unmatched-pattern", file]);
  return patches;
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      ref: { type: "string", default: "HEAD" },
      base: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });
  const ref = values.ref;
  const base = values.base ?? readBase(ref).tag;
  const file = NodePath.join(REPO_ROOT, PATCHES_FILE);
  const before = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
  const patches = writePatches(ref, base);
  const after = NodeFS.readFileSync(file, "utf8");
  for (const patch of patches) console.log(`${patch.file}\t+${patch.added} -${patch.removed}`);
  console.log(`${patches.length} upstream files patched against ${base}. Wrote ${PATCHES_FILE}.`);
  if (values.check && before !== after) {
    console.error(`${PATCHES_FILE} was out of date.`);
    process.exit(1);
  }
}
