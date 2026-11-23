import { KUD_CODE, KUD_IDENTITY } from "@t3tools/shared/kudIdentity";
import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, ".t3"),
  );
}

/** Where the T3 server on this base dir keeps its state (`environment-id`, owner lock, runtime). */
export function resolveDesktopServerStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}

/** The desktop app's own state. Kud Code keeps it apart: its Keychain key differs from T3 Code's. */
export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  if (!KUD_CODE) return resolveDesktopServerStateDir(input);
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(
    input.baseDir,
    useDevSubdir ? KUD_IDENTITY.devStateDirName : KUD_IDENTITY.stateDirName,
  );
}
