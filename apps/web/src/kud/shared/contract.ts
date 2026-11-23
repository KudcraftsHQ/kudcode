// Kud Code: the contract between the canvas (apps/web/src/kud/canvas) and the fork actions
// (apps/web/src/kud/fork). The canvas reads links and calls actions through this file only, so the
// two can be built and rebased independently.
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";

/**
 * Thread tag that records a parent the user linked by hand: `kud:parent:<threadId>`. Tags hold at
 * most 64 characters, so `setManualParent` refuses a parent id longer than 53 instead of storing
 * a shortened one: the tag always holds the whole id.
 * @public
 */
export const KUD_PARENT_TAG_PREFIX = "kud:parent:";

/** @public */
export function kudParentTag(parentThreadId: ThreadId): string {
  return `${KUD_PARENT_TAG_PREFIX}${parentThreadId}`;
}

/** The parent a user linked by hand, from a thread's tags. Engine lineage always wins over this. */
export function readKudParentTag(tags: ReadonlyArray<string> | undefined): ThreadId | null {
  const tag = tags?.find((value) => value.startsWith(KUD_PARENT_TAG_PREFIX));
  if (tag === undefined) return null;
  const id = tag.slice(KUD_PARENT_TAG_PREFIX.length);
  return id.length > 0 ? (id as ThreadId) : null;
}

export interface KudForkFromInput {
  readonly thread: ScopedThreadRef;
  /** The run to fork from. Omitted: the thread's latest stable run. */
  readonly runId?: string;
}

export interface KudForkActions {
  /** Fork one child that starts from an automatic brief of the parent plus `direction`. */
  readonly forkWithBrief: (
    input: KudForkFromInput & { readonly direction: string },
  ) => Promise<ScopedThreadRef>;
  /** One brief, then one child per direction, all started in parallel. */
  readonly exploreDirections: (
    input: KudForkFromInput & { readonly directions: ReadonlyArray<string> },
  ) => Promise<ReadonlyArray<ScopedThreadRef>>;
  /** Send a fork's result back to its parent (`thread.merge_back`). */
  readonly reportBack: (child: ScopedThreadRef) => Promise<void>;
  /** Link a thread under another by hand (tag). `parent: null` unlinks. */
  readonly setManualParent: (
    child: ScopedThreadRef,
    parent: ScopedThreadRef | null,
  ) => Promise<void>;
}
