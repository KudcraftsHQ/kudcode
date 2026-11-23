// Kud Code: the one switch that lets this fork run beside the official T3 Code app.
// See docs/kudcode/DESIGN.md section 3 for the identity table this module encodes.

declare const __KUD_CODE__: boolean | undefined;

/** Builds read `KUD_CODE` (default on, `0` turns it off); tests always get upstream identity. */
export function isKudCodeBuild(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.KUD_CODE !== "0" && env.VITEST === undefined;
}

/** True in the Kud Code desktop main process and renderer; false wherever the build did not define it. */
export const KUD_CODE: boolean = typeof __KUD_CODE__ === "boolean" && __KUD_CODE__;

export const KUD_IDENTITY = {
  appId: "com.kudcrafts.kudcode",
  baseName: "Kud Code",
  artifactBaseName: "Kud-Code",
  executableName: "kudcode",
  linuxDesktopEntryId: "com.kudcrafts.KudCode",
  userDataDirName: "kudcode-v2",
  devUserDataDirName: "kudcode-dev",
  stateDirName: "kudcode",
  devStateDirName: "kudcode-dev",
  appLinkScheme: "kudcode",
  devAppLinkScheme: "kudcode-dev",
  managedPolicyDirName: "KudCode",
  repositoryUrl: "https://github.com/KudcraftsHQ/kudcode",
  /** The official app's Electron profile, read once for its theme (see DesktopLegacyLocalStorage). */
  t3UserDataDirName: "t3code-v2",
} as const;

/** The OS-routed scheme for links that must reach this app (pairing, prompt links, auth handoff). */
export function kudAppLinkScheme(development: boolean): string {
  return development ? KUD_IDENTITY.devAppLinkScheme : KUD_IDENTITY.appLinkScheme;
}

/** In Kud Code, rewrites the renderer's `t3code://app` URL to the scheme the OS routes to this app. */
export function kudOsReturnUrl(href: string): string {
  if (!KUD_CODE) return href;
  const match = /^t3code(-dev)?:/u.exec(href);
  return match
    ? `${kudAppLinkScheme(match[1] !== undefined)}:${href.slice(match[0].length)}`
    : href;
}
