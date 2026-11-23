// Kud Code: the manual link document, one JSON file per T3 server. Pure helpers only: parsing,
// serializing, edits and where the file lives on the server.
import type { ThreadId } from "@t3tools/contracts";

export const LINK_DOCUMENT_VERSION = 1;

/**
 * The store lives in the server's managed worktrees folder (`<T3 home>/worktrees`), the one place
 * outside the user's repositories that `projects.writeFile` accepts on every server: it is always a
 * known workspace and the server creates it at startup. Only files sit in `.kudcode/` (no
 * subfolders), so storage cleanup, which looks for folders two levels down, never reports it.
 */
const LINK_STORE_FOLDER = ".kudcode";
export const LINK_STORE_FILE = `${LINK_STORE_FOLDER}/links.json`;
export const LINK_STORE_BACKUP_FILE = `${LINK_STORE_FOLDER}/links.json.bak`;

export interface StoredLink {
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly label?: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface LinkDocument {
  readonly version: typeof LINK_DOCUMENT_VERSION;
  /** Bumped on every write; a writer reads it back to see whether its write survived. */
  readonly revision: number;
  /** Random id of the last write, so a writer can tell its own write from another's. */
  readonly writeId: string;
  readonly updatedAt: string;
  readonly links: ReadonlyArray<StoredLink>;
}

export const EMPTY_LINK_DOCUMENT: LinkDocument = {
  version: LINK_DOCUMENT_VERSION,
  revision: 0,
  writeId: "",
  updatedAt: "",
  links: [],
};

/** The server's managed worktrees folder, from the keybindings path every server reports. */
export function serverWorktreesDir(keybindingsConfigPath: string): string | null {
  // `<T3 home>/<userdata|dev>/keybindings.json`; a Windows server reports backslashes.
  const separator = keybindingsConfigPath.includes("/") ? "/" : "\\";
  const parts = keybindingsConfigPath.split(separator);
  if (parts.length < 3) return null;
  const home = parts.slice(0, -2).join(separator);
  return home === "" ? null : `${home}${separator}worktrees`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLink(value: unknown): StoredLink | null {
  if (!isRecord(value)) return null;
  const { parentThreadId, childThreadId, label, createdAt, createdBy } = value;
  if (typeof parentThreadId !== "string" || parentThreadId === "") return null;
  if (typeof childThreadId !== "string" || childThreadId === "") return null;
  if (parentThreadId === childThreadId) return null;
  return {
    parentThreadId: parentThreadId as ThreadId,
    childThreadId: childThreadId as ThreadId,
    ...(typeof label === "string" && label.trim() !== "" ? { label: label.trim() } : {}),
    createdAt: typeof createdAt === "string" ? createdAt : "",
    createdBy: typeof createdBy === "string" ? createdBy : "",
  };
}

export type ParsedLinkDocument =
  | { readonly type: "ok"; readonly document: LinkDocument }
  | { readonly type: "missing" }
  | { readonly type: "corrupt" };

/** Reads the file's text. Unknown fields are dropped; a newer `version` is read as far as it fits. */
export function parseLinkDocument(text: string | null): ParsedLinkDocument {
  if (text === null || text.trim() === "") return { type: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { type: "corrupt" };
  }
  if (!isRecord(raw) || !Array.isArray(raw.links)) return { type: "corrupt" };
  // One parent per child: the first entry for a child wins.
  const seen = new Set<string>();
  const links: StoredLink[] = [];
  for (const entry of raw.links) {
    const link = readLink(entry);
    if (link === null || seen.has(link.childThreadId)) continue;
    seen.add(link.childThreadId);
    links.push(link);
  }
  return {
    type: "ok",
    document: {
      version: LINK_DOCUMENT_VERSION,
      revision: typeof raw.revision === "number" && raw.revision >= 0 ? raw.revision : 0,
      writeId: typeof raw.writeId === "string" ? raw.writeId : "",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      links,
    },
  };
}

export function serializeLinkDocument(document: LinkDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function findLink(document: LinkDocument, childThreadId: string): StoredLink | null {
  return document.links.find((link) => link.childThreadId === childThreadId) ?? null;
}

/** Sets the child's parent (replacing any other), or removes it when `link` is null. */
export function withLink(
  links: ReadonlyArray<StoredLink>,
  childThreadId: string,
  link: StoredLink | null,
): ReadonlyArray<StoredLink> {
  const others = links.filter((entry) => entry.childThreadId !== childThreadId);
  return link === null ? others : [...others, link];
}

export function sameLinks(a: ReadonlyArray<StoredLink>, b: ReadonlyArray<StoredLink>): boolean {
  if (a.length !== b.length) return false;
  return a.every((link, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      other.parentThreadId === link.parentThreadId &&
      other.childThreadId === link.childThreadId &&
      other.label === link.label
    );
  });
}
