#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off extendsNativeError:off - a synchronous git/vp driver run from a terminal, outside any Effect runtime.
// Rebases the Kud commits onto a new upstream nightly, verifies, builds, installs and publishes.
// Runbook: docs/kudcode/UPDATING.md. Every step is resumable with --continue.

import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  BASE_FILE,
  PATCHES_FILE,
  REPO_ROOT,
  git,
  gitOk,
  gitPath,
  hasCommand,
  isMac,
  localNightlyTags,
  newestNightly,
  notify,
  parseNightlyTag,
  compareNightly,
  protocolVersionAt,
  readBase,
  readJson,
  run,
  sleepSync,
} from "./lib.ts";
import { writePatches } from "./patches.ts";

const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";
const TRANSLATIONS = /^apps\/(web|mobile)\/src\/i18n\/translations\/[^/]+\.json$/;
const LOCKFILE = "pnpm-lock.yaml";
const BOOKKEEPING_SUBJECT = "chore(kud): update to ";
const TYPECHECK_DIRS = [
  "packages/contracts",
  "packages/shared",
  "packages/client-runtime",
  "apps/web",
  "apps/desktop",
  "scripts",
];
const LINTABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const MAX_FIX_ROUNDS = 3;
const MAX_AGENT_TRIES_PER_COMMIT = 2;
const INSTALL_DIR = "/Applications";
const APP_NAME = "Kud Code";
const T3_BUNDLE_ID = "com.t3tools.t3code";
const REBASE_GIT = [
  "-c",
  "rerere.enabled=true",
  "-c",
  "rerere.autoUpdate=true",
  "-c",
  "core.hooksPath=/dev/null",
];

type Step = "rebase" | "verify" | "record" | "build" | "install" | "publish" | "done";

interface Options {
  readonly agent: boolean;
  readonly agentMode: string;
  readonly build: string | undefined;
  readonly install: boolean;
  readonly push: boolean;
  readonly notify: string | undefined;
}

interface State {
  readonly mainBranch: string;
  readonly remoteMain: string | undefined;
  readonly sourceSha: string;
  readonly originalRef: string;
  readonly base: string;
  readonly target: string;
  readonly branch: string;
  readonly dropped: string[];
  readonly autoResolved: string[];
  readonly agentResolved: string[];
  readonly manualResolved: string[];
  readonly skippedEmpty: string[];
  readonly agentTries: Record<string, number>;
  fixRounds: number;
  pendingManual: string[];
  presented: string[];
  presentedFor: string;
  step: Step;
  buildPath: string | undefined;
  installedPath: string | undefined;
  options: Options;
}

class Stop extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

const statePath = () => gitPath("kud-update.json");
const loadState = () => readJson<State>(statePath());
const saveState = (state: State) =>
  NodeFS.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
const say = (line: string) => console.log(`[kud:update] ${line}`);

function rebaseInProgress(): boolean {
  return NodeFS.existsSync(gitPath("rebase-merge")) || NodeFS.existsSync(gitPath("rebase-apply"));
}

function unmergedFiles(): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
}

function isGenerated(file: string): boolean {
  return (
    file === ROUTE_TREE ||
    file === LOCKFILE ||
    file === BASE_FILE ||
    file === PATCHES_FILE ||
    TRANSLATIONS.test(file)
  );
}

function hasMarkers(file: string): boolean {
  try {
    return /^(<{7}|>{7})( |$)/m.test(NodeFS.readFileSync(NodePath.join(REPO_ROOT, file), "utf8"));
  } catch {
    return false;
  }
}

function oneSided(file: string): boolean {
  const stages = new Set(
    git(["ls-files", "--unmerged", "--", file])
      .split("\n")
      .map((line) => line.split(/\s+/)[2]),
  );
  return !stages.has("2") || !stages.has("3");
}

function replaying(): { readonly sha: string; readonly subject: string } {
  const sha = git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], { allowFail: true });
  return { sha, subject: sha ? git(["log", "-1", "--format=%s", sha]) : "(unknown commit)" };
}

function vp(args: ReadonlyArray<string>, cwd = REPO_ROOT, inherit = true) {
  return run("vp", args, { cwd, inherit });
}

function stageSide(file: string, side: "--ours" | "--theirs"): void {
  if (run("git", ["checkout", side, "--", file]).status === 0) {
    git(["add", "--", file]);
  } else {
    git(["rm", "--quiet", "--force", "--", file]);
  }
}

function stageJson(stage: 1 | 2 | 3, file: string): Record<string, unknown> {
  const shown = run("git", ["show", `:${stage}:${file}`]);
  if (shown.status !== 0) return {};
  try {
    return JSON.parse(shown.stdout) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Key-level three-way merge: upstream's map, plus the keys the replayed Kud commit added or changed. */
function mergeTranslations(file: string): void {
  const base = stageJson(1, file);
  const ours = stageJson(2, file);
  const theirs = stageJson(3, file);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const merged: Record<string, unknown> = { ...ours };
  for (const [key, value] of Object.entries(theirs)) {
    if (!(key in base)) {
      if (!(key in ours)) merged[key] = value;
    } else if (!same(value, base[key]) && same(ours[key], base[key])) {
      merged[key] = value;
    }
  }
  for (const key of Object.keys(base)) {
    if (!(key in theirs) && same(ours[key], base[key])) delete merged[key];
  }
  NodeFS.writeFileSync(NodePath.join(REPO_ROOT, file), `${JSON.stringify(merged, null, 2)}\n`);
}

async function regenerateRouteTree(): Promise<void> {
  const webDir = NodePath.join(REPO_ROOT, "apps/web");
  const webRequire = NodeModule.createRequire(NodePath.join(webDir, "package.json"));
  const pluginRequire = NodeModule.createRequire(
    webRequire.resolve("@tanstack/router-plugin/package.json"),
  );
  const generator = (await import(pluginRequire.resolve("@tanstack/router-generator"))) as {
    getConfig: (input: Record<string, unknown>, root: string) => unknown;
    Generator: new (input: { config: unknown; root: string }) => { run: () => Promise<void> };
  };
  const config = generator.getConfig({ autoCodeSplitting: true }, webDir);
  await new generator.Generator({ config, root: webDir }).run();
}

async function resolveGenerated(files: ReadonlyArray<string>, state: State): Promise<void> {
  const { subject } = replaying();
  for (const file of files) {
    if (file === BASE_FILE || file === PATCHES_FILE) {
      stageSide(file, "--theirs");
    } else if (file === LOCKFILE) {
      stageSide(file, "--ours");
    } else if (file === ROUTE_TREE) {
      stageSide(file, "--ours");
    } else {
      mergeTranslations(file);
    }
    state.autoResolved.push(`${file} (${subject})`);
  }
  if (files.includes(LOCKFILE)) {
    say("Regenerating pnpm-lock.yaml with vp install --lockfile-only");
    if (vp(["install", "--lockfile-only"]).status !== 0) {
      throw new Stop(
        "vp install --lockfile-only failed while regenerating pnpm-lock.yaml. Fix it, git add, then --continue.",
        2,
      );
    }
    git(["add", "--", LOCKFILE]);
  }
  if (files.includes(ROUTE_TREE)) {
    say(`Regenerating ${ROUTE_TREE} with the TanStack router generator`);
    await regenerateRouteTree();
    git(["add", "--", ROUTE_TREE]);
  }
  const translations = files.filter((file) => TRANSLATIONS.test(file));
  if (translations.length > 0) {
    say(`Merged ${translations.length} translation files key by key`);
    vp(["fmt", "--no-error-on-unmatched-pattern", ...translations], REPO_ROOT, false);
    git(["add", "--", ...translations]);
  }
}

function patchesContext(): string {
  try {
    return NodeFS.readFileSync(NodePath.join(REPO_ROOT, PATCHES_FILE), "utf8");
  } catch {
    return "";
  }
}

function runAgent(prompt: string, mode: string): boolean {
  if (!hasCommand("claude")) {
    say("--agent: claude is not on PATH.");
    return false;
  }
  say(`Handing over to claude -p (${mode})`);
  const result = run(
    "claude",
    [
      "-p",
      "--permission-mode",
      mode,
      "--allowedTools",
      "Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git status:*)",
    ],
    { input: prompt, inherit: true },
  );
  return result.status === 0;
}

function conflictPrompt(state: State, files: ReadonlyArray<string>): string {
  const { sha, subject } = replaying();
  return [
    `You are resolving git rebase conflicts in Kud Code, a fork of T3 Code, at ${REPO_ROOT}.`,
    `The Kud commits are being rebased from upstream tag ${state.base} onto ${state.target}.`,
    `Git stopped while replaying Kud commit ${sha.slice(0, 10)} "${subject}".`,
    "",
    "Conflicting files:",
    ...files.map((file) => `- ${file}`),
    "",
    "Read docs/kudcode/DESIGN.md and docs/kudcode/PATCHES.md first: they say what each Kud change is for.",
    `See the Kud intent with \`git show ${sha.slice(0, 10)} -- <file>\` and upstream's change with`,
    `\`git diff ${state.base} ${state.target} -- <file>\`. In the conflict, the HEAD side is upstream plus`,
    "earlier Kud commits; the other side is the Kud commit being replayed.",
    "",
    "Rule: keep upstream's change and re-apply the Kud intent on top of it, as a small diff.",
    "Remove every conflict marker. Edit only the files listed above. Do not run git add, git rebase,",
    "git commit, installs, builds or tests, and do not touch routeTree.gen.ts, i18n translation JSON or",
    "pnpm-lock.yaml (the script regenerates them). Finish with one line per file saying what you kept.",
  ].join("\n");
}

function printManual(
  state: State,
  real: ReadonlyArray<string>,
  generated: ReadonlyArray<string>,
): never {
  const { sha, subject } = replaying();
  const patches = patchesContext()
    .split("\n")
    .filter((line) => real.some((file) => line.includes(`\`${file}\``)));
  const lines = [
    "",
    `Rebase stopped on ${sha.slice(0, 10)} "${subject}" (${state.base} -> ${state.target}).`,
    "Resolve these files by hand: keep upstream's change and re-apply the Kud intent.",
    ...real.map((file) => `  ${file}`),
    ...(patches.length > 0
      ? ["What PATCHES.md says about them:", ...patches.map((line) => `  ${line}`)]
      : []),
    ...(generated.length > 0
      ? [
          "These are regenerated for you on --continue, leave them:",
          ...generated.map((f) => `  ${f}`),
        ]
      : []),
    "",
    `  Kud intent:        git show ${sha.slice(0, 10)} -- <file>`,
    `  Upstream change:   git diff ${state.base} ${state.target} -- <file>`,
    "  Then resume:       node scripts/kud/update.ts --continue   (no need to git add)",
    "  Or let an agent:   node scripts/kud/update.ts --continue --agent",
    "  Or give up:        node scripts/kud/update.ts --abort",
  ];
  throw new Stop(lines.join("\n"), 2);
}

async function driveRebase(state: State): Promise<void> {
  let stalls = 0;
  while (rebaseInProgress()) {
    const unmerged = unmergedFiles();
    const generated = unmerged.filter(isGenerated);
    const real = unmerged.filter((file) => !isGenerated(file));
    const { sha, subject } = replaying();
    if (state.presentedFor !== sha) {
      state.presentedFor = sha;
      state.presented = [];
    }
    const needsWork = real.filter(
      (file) => hasMarkers(file) || oneSided(file) || !state.presented.includes(file),
    );
    const resolved = real.filter((file) => !needsWork.includes(file));

    if (needsWork.length > 0) {
      const tries = state.agentTries[sha] ?? 0;
      if (!state.options.agent || tries >= MAX_AGENT_TRIES_PER_COMMIT || needsWork.some(oneSided)) {
        state.pendingManual = needsWork;
        state.presented = [...new Set([...state.presented, ...needsWork])];
        saveState(state);
        printManual(state, needsWork, generated);
      }
      state.agentTries[sha] = tries + 1;
      state.presented = [...new Set([...state.presented, ...needsWork])];
      saveState(state);
      runAgent(conflictPrompt(state, needsWork), state.options.agentMode);
      continue;
    }
    if (resolved.length > 0) {
      git(["add", "--", ...resolved]);
      for (const file of resolved) {
        const list = state.pendingManual.includes(file)
          ? state.manualResolved
          : state.agentResolved;
        list.push(`${file} (${subject})`);
      }
      state.pendingManual = state.pendingManual.filter((file) => !resolved.includes(file));
      saveState(state);
    }
    if (generated.length > 0) {
      await resolveGenerated(generated, state);
      saveState(state);
      continue;
    }

    const stray = git(["diff", "--name-only"]).split("\n").filter(Boolean);
    if (stray.length > 0) {
      throw new Stop(
        [
          "These files have unstaged edits outside the conflict, so git will not continue:",
          ...stray.map((file) => `  ${file}`),
          "Stage them (git add) if they belong to this commit, or revert them, then --continue.",
        ].join("\n"),
        2,
      );
    }
    const env = { ...process.env, GIT_EDITOR: "true" };
    const nothingStaged = gitOk(["diff", "--cached", "--quiet"]);
    const action = nothingStaged ? "--skip" : "--continue";
    if (nothingStaged && sha) state.skippedEmpty.push(subject);
    const result = run("git", [...REBASE_GIT, "rebase", action], { env, inherit: true });
    saveState(state);
    if (result.status !== 0 && unmergedFiles().length === 0) {
      stalls += 1;
      if (stalls >= 3)
        throw new Stop("git rebase --continue keeps failing; see its output above.", 1);
    } else {
      stalls = 0;
    }
  }
  state.pendingManual = [];
  if (!gitOk(["merge-base", "--is-ancestor", state.target, "HEAD"])) {
    throw new Stop(
      `The rebase onto ${state.target} did not complete; see the git output above.`,
      1,
    );
  }
}

function startRebase(state: State): void {
  git(["switch", "--quiet", "-C", state.branch, state.sourceSha]);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: "true" };
  const args = [...REBASE_GIT, "rebase", "--empty=drop", "--no-autosquash", "--no-update-refs"];
  if (state.dropped.length > 0) {
    env.GIT_SEQUENCE_EDITOR = `node "${NodePath.join(REPO_ROOT, "scripts/kud/update.ts")}" --drop-todo ${state.dropped.join(",")}`;
    args.push("--interactive");
  }
  say(`git rebase --onto ${state.target} ${state.base} (${state.branch})`);
  run("git", [...args, "--onto", state.target, state.base], { env, inherit: true });
}

function bookkeepingCommits(base: string, tip: string): string[] {
  const shas = git(["rev-list", `${base}..${tip}`])
    .split("\n")
    .filter(Boolean);
  return shas.filter((sha) => {
    if (!git(["log", "-1", "--format=%s", sha]).startsWith(BOOKKEEPING_SUBJECT)) return false;
    const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
      .split("\n")
      .filter(Boolean);
    return files.every((file) => file === BASE_FILE || file === PATCHES_FILE);
  });
}

function checks(state: State): { readonly ok: boolean; readonly output: string } {
  let output = "";
  let ok = true;
  for (const dir of TYPECHECK_DIRS) {
    say(`typecheck ${dir}`);
    const result = vp(["run", "typecheck"], NodePath.join(REPO_ROOT, dir), false);
    if (result.status !== 0) {
      ok = false;
      output += `\n## typecheck ${dir}\n${(result.stdout + result.stderr).trim().split("\n").slice(-150).join("\n")}\n`;
    }
  }
  const kudFiles = git(["diff", "--name-only", "--diff-filter=d", state.target, "HEAD"])
    .split("\n")
    .filter((file) => LINTABLE.test(file) && !isGenerated(file));
  if (kudFiles.length > 0) {
    say(`vp lint on ${kudFiles.length} Kud files`);
    const result = vp(["lint", "--no-error-on-unmatched-pattern", ...kudFiles], REPO_ROOT, false);
    if (result.status !== 0) {
      ok = false;
      output += `\n## vp lint\n${(result.stdout + result.stderr).trim().split("\n").slice(-150).join("\n")}\n`;
    }
  }
  return { ok, output };
}

function fixPrompt(state: State, output: string): string {
  return [
    `Kud Code (a fork of T3 Code, at ${REPO_ROOT}) was just rebased from upstream ${state.base} onto ${state.target}.`,
    "These checks now fail:",
    output.trim(),
    "",
    "Read docs/kudcode/DESIGN.md and docs/kudcode/PATCHES.md. Fix the errors by adapting the Kud code to",
    `upstream's new APIs (see \`git diff ${state.base} ${state.target}\`); keep upstream's behavior. Keep`,
    "edits to upstream files minimal. No new dependencies, no tests, no git commands that change state.",
    "Finish with one line per file you changed.",
  ].join("\n");
}

async function verify(state: State): Promise<void> {
  if (NodeFS.existsSync(NodePath.join(REPO_ROOT, ROUTE_TREE))) await regenerateRouteTree();
  say("vp install");
  if (vp(["install"]).status !== 0)
    throw new Stop("vp install failed. Fix it, then --continue.", 1);
  for (;;) {
    const result = checks(state);
    if (result.ok) break;
    if (!state.options.agent || state.fixRounds >= MAX_FIX_ROUNDS) {
      console.error(result.output);
      throw new Stop(
        [
          `Checks fail on ${state.branch}${state.options.agent ? ` after ${state.fixRounds} agent rounds` : ""}.`,
          "Fix them in this checkout (edits may stay uncommitted), then: node scripts/kud/update.ts --continue",
          "Or let an agent try: node scripts/kud/update.ts --continue --agent",
        ].join("\n"),
        2,
      );
    }
    state.fixRounds += 1;
    saveState(state);
    say(`Fix round ${state.fixRounds}/${MAX_FIX_ROUNDS}`);
    runAgent(fixPrompt(state, result.output), state.options.agentMode);
  }
  if (git(["status", "--porcelain"]) !== "") {
    git(["add", "--all"]);
    git(["commit", "--quiet", "-m", `fix(kud): build on ${state.target}`]);
    say(`Committed fixes as "fix(kud): build on ${state.target}"`);
  }
}

function record(state: State): void {
  NodeFS.mkdirSync(NodePath.join(REPO_ROOT, NodePath.dirname(BASE_FILE)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(REPO_ROOT, BASE_FILE), `${state.target}\n`);
  writePatches("HEAD", state.target);
  git(["add", "--", BASE_FILE, PATCHES_FILE]);
  if (!gitOk(["diff", "--cached", "--quiet"])) {
    git(["commit", "--quiet", "-m", `${BOOKKEEPING_SUBJECT}${state.target}`]);
  }
}

function build(state: State): void {
  if (state.options.build !== "mac") return;
  if (!isMac()) {
    say("--build mac must run on the Mac (it builds the arm64 DMG). Skipping the build here.");
    return;
  }
  say("vp run dist:desktop:dmg:arm64 (unsigned)");
  const started = Date.now();
  if (vp(["run", "dist:desktop:dmg:arm64"]).status !== 0) {
    throw new Stop("The DMG build failed; see the output above. Fix it, then --continue.", 1);
  }
  const releaseDir = NodePath.join(REPO_ROOT, "release");
  const dmg = NodeFS.readdirSync(releaseDir)
    .filter((name) => name.endsWith(".dmg"))
    .map((name) => NodePath.join(releaseDir, name))
    .filter((file) => NodeFS.statSync(file).mtimeMs >= started)
    .toSorted((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)[0];
  if (!dmg) throw new Stop(`The build finished but left no new .dmg in ${releaseDir}.`, 1);
  state.buildPath = dmg;
}

function plistValue(app: string, key: string): string {
  return run("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    NodePath.join(app, "Contents/Info.plist"),
  ]).stdout.trim();
}

function quitApp(bundleId: string): void {
  const running = () =>
    run("osascript", ["-e", `application id "${bundleId}" is running`]).stdout.trim() === "true";
  if (!running()) return;
  say(`Quitting the running ${APP_NAME}`);
  run("osascript", ["-e", `tell application id "${bundleId}" to quit`]);
  for (let waited = 0; running(); waited += 500) {
    if (waited > 30_000)
      throw new Stop(`${APP_NAME} did not quit within 30 s. Quit it, then --continue.`, 1);
    sleepSync(500);
  }
}

function install(state: State): void {
  if (!state.options.install) return;
  if (!isMac() || !state.buildPath) {
    say("--install needs a Mac build (--build mac on the Mac). Skipping the install.");
    return;
  }
  const mount = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kud-dmg-"));
  if (
    run("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-noautoopen",
      "-mountpoint",
      mount,
      state.buildPath,
    ]).status !== 0
  ) {
    throw new Stop(`Could not mount ${state.buildPath}.`, 1);
  }
  try {
    const appName = NodeFS.readdirSync(mount).find((name) => name.endsWith(".app"));
    if (!appName) throw new Stop(`No .app inside ${state.buildPath}.`, 1);
    const source = NodePath.join(mount, appName);
    const bundleId = plistValue(source, "CFBundleIdentifier");
    if (!appName.startsWith(APP_NAME) || bundleId === T3_BUNDLE_ID || bundleId === "") {
      throw new Stop(
        `The build is "${appName}" (${bundleId || "no bundle id"}), not ${APP_NAME}. The Kud identity is missing; not installing.`,
        1,
      );
    }
    const dest = NodePath.join(INSTALL_DIR, `${APP_NAME}.app`);
    const previous = NodePath.join(INSTALL_DIR, `${APP_NAME} (previous).app`);
    quitApp(bundleId);
    if (NodeFS.existsSync(dest)) {
      NodeFS.rmSync(previous, { recursive: true, force: true });
      NodeFS.renameSync(dest, previous);
    }
    if (run("ditto", [source, dest], { inherit: true }).status !== 0) {
      throw new Stop(`Copying ${appName} to ${dest} failed.`, 1);
    }
    run("xattr", ["-dr", "com.apple.quarantine", dest]);
    if (run("codesign", ["--verify", "--deep", dest]).status !== 0) {
      run("codesign", ["--force", "--deep", "--sign", "-", dest]);
    }
    state.installedPath = dest;
  } finally {
    run("hdiutil", ["detach", mount, "-quiet"]);
    NodeFS.rmSync(mount, { recursive: true, force: true });
  }
}

function checkedOutElsewhere(branch: string): string | undefined {
  const here = NodePath.resolve(git(["rev-parse", "--show-toplevel"]));
  let path = "";
  for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && NodePath.resolve(path) !== here) return path;
  }
  return undefined;
}

function publish(state: State): void {
  const head = git(["rev-parse", "HEAD"]);
  const releaseTag = `kud-${state.target}`;
  git(["tag", "--force", "kud-prev", state.sourceSha]);
  git(["tag", "--force", releaseTag, head]);
  if (state.options.push) {
    say(`Pushing ${state.branch} to origin/${state.mainBranch} (--force-with-lease)`);
    const lease = `--force-with-lease=refs/heads/${state.mainBranch}:${state.remoteMain ?? ""}`;
    if (
      run("git", ["push", lease, "origin", `${head}:refs/heads/${state.mainBranch}`], {
        inherit: true,
      }).status !== 0
    ) {
      throw new Stop(
        `origin/${state.mainBranch} moved since the update started. Run --abort, then start the update again.`,
        1,
      );
    }
    run("git", ["push", "origin", "+refs/tags/kud-prev", `+refs/tags/${releaseTag}`], {
      inherit: true,
    });
  }
  const elsewhere = checkedOutElsewhere(state.mainBranch);
  if (elsewhere) {
    say(
      `${state.mainBranch} is checked out in ${elsewhere}; there run: git fetch origin && git reset --keep ${head.slice(0, 10)}`,
    );
  } else {
    git(["branch", "--force", state.mainBranch, head]);
  }
}

async function resolveTarget(values: {
  readonly to: string | undefined;
  readonly "match-server": string | undefined;
}): Promise<{ readonly tag: string; readonly serverProtocol: number | undefined }> {
  if (values.to) return { tag: values.to, serverProtocol: undefined };
  if (values["match-server"]) {
    const origin = /^https?:\/\//.test(values["match-server"])
      ? values["match-server"]
      : `http://${values["match-server"]}`;
    const url = new URL("/.well-known/t3/environment", origin);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok)
      throw new Stop(
        `${url.origin} answered ${response.status} for /.well-known/t3/environment.`,
        1,
      );
    const descriptor = (await response.json()) as {
      serverVersion?: string;
      orchestrationProtocolVersion?: number;
    };
    if (!descriptor.serverVersion)
      throw new Stop(`${url.origin} did not report a serverVersion.`, 1);
    const tag = `v${descriptor.serverVersion}`;
    if (!parseNightlyTag(tag)) {
      throw new Stop(
        `The server reports ${descriptor.serverVersion}, which is not a nightly release; use --to <tag>.`,
        1,
      );
    }
    say(
      `${url.origin} runs ${descriptor.serverVersion} (protocol ${descriptor.orchestrationProtocolVersion ?? 1})`,
    );
    return { tag, serverProtocol: descriptor.orchestrationProtocolVersion ?? 1 };
  }
  const newest = newestNightly(localNightlyTags());
  if (!newest) throw new Stop("No upstream v*-nightly.* tags found. Fetch upstream tags.", 1);
  return { tag: newest.tag, serverProtocol: undefined };
}

function dropFromTodo(shas: string, todoFile: string): void {
  const drop = shas.split(",").filter(Boolean);
  const lines = NodeFS.readFileSync(todoFile, "utf8").split("\n");
  const kept = lines.filter((line) => {
    const sha = /^(?:p|pick)\s+([0-9a-f]+)/.exec(line)?.[1];
    return !sha || !drop.some((full) => full.startsWith(sha));
  });
  NodeFS.writeFileSync(todoFile, kept.join("\n"));
}

function summary(state: State): string {
  const replayed = git(["rev-list", "--count", `${state.target}..HEAD`]);
  const list = (label: string, items: ReadonlyArray<string>) =>
    items.length > 0 ? [`${label}:`, ...items.map((item) => `  ${item}`)] : [];
  return [
    "",
    `Kud Code: ${state.base} -> ${state.target}`,
    `Branch ${state.branch}, ${replayed} Kud commits on top of ${state.target}.`,
    ...list("Regenerated", state.autoResolved),
    ...list("Resolved by the agent", state.agentResolved),
    ...list("Resolved by hand", state.manualResolved),
    ...list("Dropped as already upstream or empty", state.skippedEmpty),
    ...(state.fixRounds > 0 ? [`Agent fix rounds: ${state.fixRounds}`] : []),
    `Build: ${state.buildPath ?? "none"}`,
    ...(state.installedPath
      ? [`Installed: ${state.installedPath} (previous kept as "${APP_NAME} (previous).app")`]
      : []),
    state.options.push
      ? `Published: origin/${state.mainBranch} = ${state.branch}, tags kud-${state.target} and kud-prev`
      : `Not pushed (--no-push). Local ${state.mainBranch}, kud-${state.target} and kud-prev moved.`,
  ].join("\n");
}

async function begin(
  values: Record<string, string | boolean | undefined>,
  options: Options,
): Promise<State | undefined> {
  if (rebaseInProgress())
    throw new Stop(
      "A rebase is already in progress in this checkout. Finish or abort it first.",
      1,
    );
  if (git(["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Stop("The working tree has uncommitted changes. Commit or stash them first.", 1);
  }
  const mainBranch = String(values.main);
  if (values.fetch) {
    say("Fetching upstream tags");
    git(["fetch", "--quiet", "--tags", "upstream"]);
  }
  const remoteHasMain = values.fetch
    ? git(["ls-remote", "--heads", "origin", mainBranch]) !== ""
    : gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${mainBranch}`]);
  if (remoteHasMain && values.fetch) git(["fetch", "--quiet", "origin", mainBranch]);
  const sourceRef = remoteHasMain ? `origin/${mainBranch}` : mainBranch;
  const sourceSha = git(["rev-parse", `${sourceRef}^{commit}`]);
  const remoteMain = remoteHasMain ? sourceSha : undefined;
  if (remoteHasMain && gitOk(["rev-parse", "--verify", "--quiet", mainBranch])) {
    const unpushed = git(["rev-list", "--count", `${sourceRef}..${mainBranch}`]);
    if (unpushed !== "0")
      say(
        `Local ${mainBranch} has ${unpushed} commits not on ${sourceRef}; they are not included.`,
      );
  }

  const base = readBase(sourceSha);
  const target = await resolveTarget({
    to: values.to as string | undefined,
    "match-server": values["match-server"] as string | undefined,
  });
  if (!gitOk(["rev-parse", "--verify", "--quiet", `refs/tags/${target.tag}^{commit}`])) {
    throw new Stop(
      `Upstream tag ${target.tag} is not here. Fetch upstream tags (drop --no-fetch).`,
      1,
    );
  }
  const baseProtocol = protocolVersionAt(base.tag);
  const targetProtocol = protocolVersionAt(target.tag);
  say(`Base   ${base.tag} (from ${base.source}), protocol ${baseProtocol ?? "?"}`);
  say(`Target ${target.tag}, protocol ${targetProtocol ?? "?"}`);
  if (target.tag === base.tag) {
    say(`Already on ${target.tag}. Nothing to do.`);
    return undefined;
  }
  const parsedBase = parseNightlyTag(base.tag);
  const parsedTarget = parseNightlyTag(target.tag);
  if (parsedBase && parsedTarget && compareNightly(parsedTarget, parsedBase) < 0 && !values.force) {
    throw new Stop(
      `${target.tag} is older than the current base ${base.tag}. Pass --force to go back.`,
      1,
    );
  }
  if (baseProtocol !== targetProtocol && !values.force) {
    throw new Stop(
      `ORCHESTRATION_PROTOCOL_VERSION changes from ${baseProtocol} to ${targetProtocol}. Kud Code would stop talking to servers on the old protocol. Pass --force if that is intended.`,
      1,
    );
  }
  if (
    target.serverProtocol !== undefined &&
    target.serverProtocol !== targetProtocol &&
    !values.force
  ) {
    throw new Stop(
      `The server speaks protocol ${target.serverProtocol}, ${target.tag} speaks ${targetProtocol}. Pass --force to continue.`,
      1,
    );
  }

  const originalRef =
    git(["symbolic-ref", "--short", "--quiet", "HEAD"], { allowFail: true }) ||
    git(["rev-parse", "HEAD"]);
  const branch = `kud/update-${target.tag}`;
  if (checkedOutElsewhere(branch))
    throw new Stop(`${branch} is checked out in another worktree.`, 1);
  const dropped = bookkeepingCommits(base.tag, sourceSha);
  const commits = git(["rev-list", "--count", `${base.tag}..${sourceSha}`]);
  say(
    `Replaying ${Number(commits) - dropped.length} Kud commits (${dropped.length} old bookkeeping commits dropped)`,
  );
  return {
    mainBranch,
    remoteMain,
    sourceSha,
    originalRef,
    base: base.tag,
    target: target.tag,
    branch,
    dropped,
    autoResolved: [],
    agentResolved: [],
    manualResolved: [],
    skippedEmpty: [],
    agentTries: {},
    fixRounds: 0,
    pendingManual: [],
    presented: [],
    presentedFor: "",
    step: "rebase",
    buildPath: undefined,
    installedPath: undefined,
    options,
  };
}

function abort(): void {
  const state = loadState();
  if (rebaseInProgress()) run("git", ["rebase", "--abort"], { inherit: true });
  if (state) {
    run("git", ["reset", "--quiet", "--hard"]);
    git([
      "switch",
      "--quiet",
      state.originalRef.match(/^[0-9a-f]{40}$/) ? "--detach" : "--no-guess",
      state.originalRef,
    ]);
    if (git(["branch", "--list", state.branch]) !== "")
      git(["branch", "--quiet", "-D", state.branch]);
    NodeFS.rmSync(statePath(), { force: true });
    say(`Aborted. Back on ${state.originalRef}; ${state.branch} deleted.`);
  } else {
    say("No update in progress.");
  }
}

const STEPS: ReadonlyArray<Step> = [
  "rebase",
  "verify",
  "record",
  "build",
  "install",
  "publish",
  "done",
];

async function main(): Promise<void> {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      to: { type: "string" },
      "match-server": { type: "string" },
      main: { type: "string", default: "main" },
      force: { type: "boolean", default: false },
      agent: { type: "boolean", default: false },
      "agent-mode": { type: "string", default: "acceptEdits" },
      build: { type: "string" },
      install: { type: "boolean", default: false },
      push: { type: "boolean", default: true },
      fetch: { type: "boolean", default: true },
      notify: { type: "string" },
      continue: { type: "boolean", default: false },
      abort: { type: "boolean", default: false },
      "drop-todo": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values["drop-todo"] !== undefined) {
    const todo = positionals.at(-1);
    if (todo) dropFromTodo(values["drop-todo"], todo);
    return;
  }
  if (values.help) {
    console.log(
      [
        "node scripts/kud/update.ts [--to <tag> | --match-server <origin>] [--agent] [--build mac] [--install]",
        "  --continue / --abort       resume or undo an update that stopped",
        "  --force                    allow a protocol change or an older target",
        "  --main <branch>            branch to update (default main); --no-push keeps it local",
        "  --no-fetch                 use the tags already here",
        "  --agent-mode <mode>        claude -p permission mode (acceptEdits or bypassPermissions)",
        "  --notify <topic>           ntfy publish the result, if ntfy is on PATH",
      ].join("\n"),
    );
    return;
  }
  if (values.abort) return abort();
  if (values.build !== undefined && values.build !== "mac")
    throw new Stop("--build only knows mac.", 1);
  if (!["acceptEdits", "bypassPermissions"].includes(values["agent-mode"])) {
    throw new Stop("--agent-mode is acceptEdits or bypassPermissions.", 1);
  }
  const options: Options = {
    agent: values.agent,
    agentMode: values["agent-mode"],
    build: values.build,
    install: values.install,
    push: values.push,
    notify: values.notify,
  };

  let state = loadState();
  if (values.continue) {
    if (!state) throw new Stop("No update to continue.", 1);
    state.options = {
      ...state.options,
      agent: state.options.agent || options.agent,
      build: state.options.build ?? options.build,
      install: state.options.install || options.install,
      notify: state.options.notify ?? options.notify,
      agentMode:
        values["agent-mode"] === "acceptEdits" ? state.options.agentMode : options.agentMode,
    };
    if (state.options.agent) state.fixRounds = Math.min(state.fixRounds, MAX_FIX_ROUNDS - 1);
  } else {
    if (state)
      throw new Stop(`An update to ${state.target} is in progress. Use --continue or --abort.`, 1);
    state = await begin(values, options);
    if (!state) return;
    saveState(state);
    startRebase(state);
  }

  const current = state;
  if (
    current.step !== "rebase" &&
    current.step !== "done" &&
    git(["branch", "--show-current"]) !== current.branch
  ) {
    git(["switch", "--quiet", current.branch]);
  }
  for (const step of STEPS.slice(STEPS.indexOf(current.step))) {
    current.step = step;
    saveState(current);
    if (step === "rebase") await driveRebase(current);
    if (step === "verify") await verify(current);
    if (step === "record") record(current);
    if (step === "build") build(current);
    if (step === "install") install(current);
    if (step === "publish") publish(current);
  }
  const text = summary(current);
  console.log(text);
  NodeFS.rmSync(statePath(), { force: true });
  if (
    current.originalRef !== current.branch &&
    git(["status", "--porcelain", "--untracked-files=no"]) === ""
  ) {
    run("git", ["switch", "--quiet", current.originalRef]);
  }
  notify(current.options.notify, `Kud Code updated to ${current.target}`, text.trim());
}

try {
  await main();
} catch (error) {
  if (error instanceof Stop) {
    console.error(error.message);
    const state = loadState();
    if (state && error.code === 2) {
      notify(
        state.options.notify,
        `Kud Code update to ${state.target} needs you`,
        error.message.trim().split("\n")[1] ?? "",
      );
    }
    process.exit(error.code);
  }
  throw error;
}
