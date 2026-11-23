// Kud Code: the manual link store. One JSON document per T3 server in its managed worktrees folder,
// read with `projects.readFile` and written with `projects.writeFile`: APIs every paired client
// already has, so the server stays unmodified. State lives at module level so the canvas and the
// fork actions share it; React reads it through `KudManualLinksProvider`.
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { request } from "@t3tools/client-runtime/rpc";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
  createEnvironmentCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { environmentServerConfigsAtom } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { KUD_PARENT_TAG_PREFIX, readKudParentTag } from "../shared/contract";
import {
  EMPTY_LINK_DOCUMENT,
  findLink,
  LINK_DOCUMENT_VERSION,
  LINK_STORE_BACKUP_FILE,
  LINK_STORE_FILE,
  type LinkDocument,
  parseLinkDocument,
  sameLinks,
  serializeLinkDocument,
  serverWorktreesDir,
  type StoredLink,
  withLink,
} from "./linkDocument";

export type LinkStoreStatus = "loading" | "loaded" | "unavailable";

export interface EnvironmentLinkState {
  readonly status: LinkStoreStatus;
  readonly document: LinkDocument;
}

/** Each environment's store; replaced (never mutated) on change, so it is a React snapshot. */
let state: ReadonlyMap<EnvironmentId, EnvironmentLinkState> = new Map();
const listeners = new Set<() => void>();

export function subscribeLinkStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readLinkStore(): ReadonlyMap<EnvironmentId, EnvironmentLinkState> {
  return state;
}

function setEnvironmentState(environmentId: EnvironmentId, next: EnvironmentLinkState) {
  const current = state.get(environmentId);
  if (
    current !== undefined &&
    current.status === next.status &&
    current.document.revision === next.document.revision &&
    sameLinks(current.document.links, next.document.links)
  )
    return;
  const copy = new Map(state);
  copy.set(environmentId, next);
  state = copy;
  for (const listener of listeners) listener();
}

const readFileCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "kud:links:read",
  execute: (input: { readonly cwd: string; readonly relativePath: string }) =>
    request(WS_METHODS.projectsReadFile, { ...input, allowMissing: true }),
});

const dispatchCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "kud:links:dispatch",
  execute: (command: OrchestrationV2Command) =>
    request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command),
});

function failureText(result: AtomCommandResult<unknown, unknown>): string {
  const fallback = m(msg("The server could not save the link."));
  if (result._tag !== "Failure") return fallback;
  return thrownErrorMessage(squashAtomCommandFailure(result), m) ?? fallback;
}

/** Where this environment keeps its links: the folder `projects.writeFile` accepts as `cwd`. */
function storeFolder(environmentId: EnvironmentId): string | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  return config === undefined ? null : serverWorktreesDir(config.keybindingsConfigPath);
}

function canWrite(environmentId: EnvironmentId): boolean {
  return readEnvironmentScope(environmentId, AuthFilesystemWriteScope);
}

type RemoteRead =
  | { readonly type: "ok"; readonly document: LinkDocument }
  | { readonly type: "failed" };

async function readRemote(environmentId: EnvironmentId, cwd: string): Promise<RemoteRead> {
  const result = await runAtomCommand(
    appAtomRegistry,
    readFileCommand,
    { environmentId, input: { cwd, relativePath: LINK_STORE_FILE } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") return { type: "failed" };
  const file = result.value;
  if (file.exists === false) return { type: "ok", document: EMPTY_LINK_DOCUMENT };
  const parsed = parseLinkDocument(file.truncated ? "" : file.contents);
  if (parsed.type === "ok") return parsed;
  if (parsed.type === "corrupt" && canWrite(environmentId)) {
    // Keep what was there before the next write replaces it; a failed copy only loses the copy.
    await writeRemote(environmentId, cwd, LINK_STORE_BACKUP_FILE, file.contents).catch(() => {});
  }
  return { type: "ok", document: EMPTY_LINK_DOCUMENT };
}

async function writeRemote(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.writeFile,
    { environmentId, input: { cwd, relativePath, contents } },
    { label: "Save canvas links", reportFailure: false },
  );
  if (result._tag !== "Success") throw new Error(failureText(result));
}

const loading = new Map<EnvironmentId, Promise<void>>();

/** Loads (or refreshes) one environment's document. Concurrent calls share one read. */
export function loadEnvironmentLinks(environmentId: EnvironmentId): Promise<void> {
  const running = loading.get(environmentId);
  if (running !== undefined) return running;
  const promise = (async () => {
    const cwd = storeFolder(environmentId);
    const previous = state.get(environmentId);
    if (cwd === null || !readEnvironmentScope(environmentId, AuthFilesystemReadScope)) {
      setEnvironmentState(environmentId, { status: "unavailable", document: EMPTY_LINK_DOCUMENT });
      return;
    }
    if (previous === undefined) {
      setEnvironmentState(environmentId, { status: "loading", document: EMPTY_LINK_DOCUMENT });
    }
    const read = await readRemote(environmentId, cwd);
    if (read.type === "ok") {
      setEnvironmentState(environmentId, { status: "loaded", document: read.document });
    } else if (previous === undefined || previous.status !== "loaded") {
      // A failed first read must not hold the canvas back; keep any earlier copy otherwise.
      setEnvironmentState(environmentId, { status: "unavailable", document: EMPTY_LINK_DOCUMENT });
    }
  })().finally(() => loading.delete(environmentId));
  loading.set(environmentId, promise);
  return promise;
}

/** Which client wrote a link: an identifier in the file, not copy shown to anyone. */
const CLIENT_ID = "kudcode";
const createdBy = (() => {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return platform === "" ? CLIENT_ID : `${CLIENT_ID}/${platform}`;
})();

const MAX_WRITE_ATTEMPTS = 4;
// One write at a time per environment from this client.
const writing = new Map<EnvironmentId, Promise<unknown>>();

/**
 * Read-modify-write with a revision check: `projects.writeFile` has no compare-and-swap or rename,
 * so after writing, the file is read back. If another client's write replaced ours, the edit is
 * applied again on top of theirs. `edit` returns null when there is nothing to change.
 */
function editDocument(
  environmentId: EnvironmentId,
  edit: (links: ReadonlyArray<StoredLink>) => ReadonlyArray<StoredLink> | null,
): Promise<void> {
  const previous = writing.get(environmentId) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const cwd = storeFolder(environmentId);
      if (cwd === null) throw new Error(m(msg("This machine is not connected.")));
      if (!canWrite(environmentId)) {
        throw new Error(m(msg("This connection cannot save links on that machine.")));
      }
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const read = await readRemote(environmentId, cwd);
        if (read.type === "failed") throw new Error(m(msg("The saved links could not be read.")));
        const links = edit(read.document.links);
        if (links === null) {
          setEnvironmentState(environmentId, { status: "loaded", document: read.document });
          return;
        }
        const next: LinkDocument = {
          version: LINK_DOCUMENT_VERSION,
          revision: read.document.revision + 1,
          writeId: randomUUID(),
          updatedAt: new Date().toISOString(),
          links,
        };
        await writeRemote(environmentId, cwd, LINK_STORE_FILE, serializeLinkDocument(next));
        const check = await readRemote(environmentId, cwd);
        if (check.type === "ok" && check.document.writeId === next.writeId) {
          setEnvironmentState(environmentId, { status: "loaded", document: check.document });
          return;
        }
      }
      throw new Error(m(msg("Another window kept changing the links. Try again.")));
    });
  writing.set(environmentId, run);
  return run.finally(() => {
    if (writing.get(environmentId) === run) writing.delete(environmentId);
  });
}

/** The parent linked by hand in the store, if this environment's store has loaded. */
export function readStoredParent(environmentId: EnvironmentId, childThreadId: string) {
  const document = state.get(environmentId)?.document;
  return document === undefined ? null : findLink(document, childThreadId);
}

export function setStoredParent(input: {
  readonly environmentId: EnvironmentId;
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly label?: string;
}): Promise<void> {
  return editDocument(input.environmentId, (links) => {
    const current = links.find((link) => link.childThreadId === input.childThreadId) ?? null;
    if (input.parentThreadId === null) {
      return current === null ? null : withLink(links, input.childThreadId, null);
    }
    if (current?.parentThreadId === input.parentThreadId && current.label === input.label) {
      return null;
    }
    return withLink(links, input.childThreadId, {
      parentThreadId: input.parentThreadId,
      childThreadId: input.childThreadId,
      ...(input.label === undefined ? {} : { label: input.label }),
      createdAt: new Date().toISOString(),
      createdBy,
    });
  });
}

function hasEngineParent(thread: EnvironmentThreadShell): boolean {
  return thread.forkedFrom?.type === "run" || thread.lineage.parentThreadId !== null;
}

// Threads being migrated now, and those done this session (their shell may still show the tag
// until the server's update arrives).
const migrating = new Set<string>();
const migrated = new Set<string>();

/**
 * Moves `kud:parent:` tags into the store, then removes the tag (other tags stay). A tag on a
 * thread with engine lineage was copied from its parent by a fork, so it is only removed. A child
 * that already has a stored parent keeps it. Safe to run again: each step checks first.
 */
export async function migrateParentTags(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): Promise<void> {
  const environmentState = state.get(environmentId);
  if (environmentState?.status !== "loaded" || !canWrite(environmentId)) return;
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
  const tagged = threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      !migrating.has(`${environmentId}:${thread.id}`) &&
      !migrated.has(`${environmentId}:${thread.id}`) &&
      readKudParentTag(thread.source.tags) !== null,
  );
  if (tagged.length === 0) return;
  for (const thread of tagged) migrating.add(`${environmentId}:${thread.id}`);
  try {
    const imports = tagged.filter((thread) => !hasEngineParent(thread));
    if (imports.length > 0) {
      await editDocument(environmentId, (links) => {
        let next = links;
        for (const thread of imports) {
          const parent = readKudParentTag(thread.source.tags);
          if (parent === null || parent === thread.id) continue;
          if (next.some((link) => link.childThreadId === thread.id)) continue;
          next = withLink(next, thread.id, {
            parentThreadId: parent,
            childThreadId: thread.id,
            createdAt: new Date().toISOString(),
            createdBy: `${createdBy}+tag`,
          });
        }
        return next === links ? null : next;
      });
    }
    for (const thread of tagged) {
      let removed = true;
      for (const tag of thread.source.tags ?? []) {
        if (!tag.startsWith(KUD_PARENT_TAG_PREFIX)) continue;
        const result = await runAtomCommand(
          appAtomRegistry,
          dispatchCommand,
          {
            environmentId,
            input: {
              type: "thread.tag.set",
              commandId: CommandId.make(randomUUID()),
              threadId: thread.id,
              tag,
              tagged: false,
            },
          },
          { reportFailure: false },
        );
        if (result._tag !== "Success") removed = false;
      }
      if (removed) migrated.add(`${environmentId}:${thread.id}`);
    }
  } catch {
    // Left for the next load: the import is idempotent and the tags are still there.
  } finally {
    for (const thread of tagged) migrating.delete(`${environmentId}:${thread.id}`);
  }
}
