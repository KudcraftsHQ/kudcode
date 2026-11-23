// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off extendsNativeError:off - a synchronous git/vp driver run from a terminal, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
export const BASE_FILE = "docs/kudcode/BASE";
export const PATCHES_FILE = "docs/kudcode/PATCHES.md";
const PROTOCOL_FILE = "packages/contracts/src/environment.ts";
const NIGHTLY_TAG = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
    readonly inherit?: boolean;
  } = {},
): RunResult {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
    stdio: options.inherit
      ? [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"]
      : "pipe",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function git(args: ReadonlyArray<string>, options: { readonly allowFail?: boolean } = {}) {
  const result = run("git", args);
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function gitOk(args: ReadonlyArray<string>): boolean {
  return run("git", args).status === 0;
}

export function hasCommand(name: string): boolean {
  return run("sh", ["-c", `command -v ${name}`]).status === 0;
}

export interface NightlyTag {
  readonly tag: string;
  readonly version: readonly [number, number, number];
  readonly date: number;
  readonly run: number;
}

export function parseNightlyTag(tag: string): NightlyTag | undefined {
  const match = NIGHTLY_TAG.exec(tag);
  if (!match) return undefined;
  return {
    tag,
    version: [Number(match[1]), Number(match[2]), Number(match[3])],
    date: Number(match[4]),
    run: Number(match[5]),
  };
}

export function compareNightly(a: NightlyTag, b: NightlyTag): number {
  return (
    a.date - b.date ||
    a.run - b.run ||
    a.version[0] - b.version[0] ||
    a.version[1] - b.version[1] ||
    a.version[2] - b.version[2]
  );
}

export function newestNightly(tags: ReadonlyArray<string>): NightlyTag | undefined {
  const parsed = tags.flatMap((tag) => parseNightlyTag(tag) ?? []);
  return parsed.toSorted(compareNightly).at(-1);
}

export function localNightlyTags(): string[] {
  return git(["tag", "--list", "v*-nightly.*"]).split("\n").filter(Boolean);
}

export function remoteNightlyTags(remote: string): string[] {
  const out = git(["ls-remote", "--tags", "--refs", remote, "v*-nightly.*"]);
  return out
    .split("\n")
    .map((line) => line.split("\t")[1]?.replace("refs/tags/", "") ?? "")
    .filter(Boolean);
}

/** The upstream nightly `ref` is built on: docs/kudcode/BASE, else the nearest nightly tag. */
export function readBase(ref: string): { readonly tag: string; readonly source: string } {
  const recorded = run("git", ["show", `${ref}:${BASE_FILE}`]);
  if (recorded.status === 0) {
    const tag = recorded.stdout.trim();
    if (!gitOk(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}^{commit}`])) {
      throw new Error(
        `${BASE_FILE} on ${ref} names ${tag}, which is not a local tag. Fetch upstream tags.`,
      );
    }
    if (!gitOk(["merge-base", "--is-ancestor", `${tag}^{commit}`, ref])) {
      throw new Error(`${BASE_FILE} on ${ref} names ${tag}, but ${ref} is not built on it.`);
    }
    return { tag, source: BASE_FILE };
  }
  const described = run("git", [
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v*-nightly.*",
    ref,
  ]);
  if (described.status !== 0) {
    throw new Error(`Cannot tell which upstream nightly ${ref} is built on (no ${BASE_FILE}).`);
  }
  return { tag: described.stdout.trim(), source: "git describe" };
}

export function protocolVersionAt(ref: string): number | undefined {
  const source = run("git", ["show", `${ref}:${PROTOCOL_FILE}`]);
  if (source.status !== 0) return undefined;
  const match = /ORCHESTRATION_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(source.stdout);
  return match ? Number(match[1]) : undefined;
}

export function gitPath(name: string): string {
  return NodePath.resolve(REPO_ROOT, git(["rev-parse", "--git-path", name]));
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function notify(topic: string | undefined, title: string, body: string): void {
  if (!topic) return;
  if (!hasCommand("ntfy")) {
    console.error("--notify: ntfy is not on PATH, skipping the notification.");
    return;
  }
  run("ntfy", ["publish", "--title", title, topic, body]);
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isMac(): boolean {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- plain Node CLI with no Effect runtime to inject HostProcess into
  return process.platform === "darwin";
}
