// Kud Code: the thread whose agent launched a thread (`senderThreadId` of its first message).
// Shells carry no messages, so this reads the bounded snapshot a client opens a thread with, once
// per thread, and keeps the answer forever: a first message never changes.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  executeConnectedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { createEnvironmentCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";

/** The launching thread's id, or `null` when the first message names none. */
export type StartedByAnswers = ReadonlyMap<string, ThreadId | null>;

const STORAGE_KEY = "kud.canvas.startedBy.v1";
const STORAGE_LIMIT = 5_000;
const CONCURRENCY = 4;
// Older history pages to read when the first message is outside the snapshot's window.
const MAX_HISTORY_PAGES = 4;
// Answers land on screen together, so families merge in a few steps instead of one per thread.
const FLUSH_INTERVAL_MS = 700;
// The trees on screen can hold many agent threads; the newest are read first.
const MAX_CANDIDATES = 200;

type FirstSender = { readonly ordinal: number; readonly sender: ThreadId | null };
type TurnItemLike = {
  readonly type: string;
  readonly ordinal?: number;
  readonly threadId?: ThreadId;
  readonly senderThreadId?: ThreadId | undefined;
};

function earliestUserMessage(
  items: Iterable<TurnItemLike>,
  threadId: ThreadId,
  current: FirstSender | null,
): FirstSender | null {
  let earliest = current;
  for (const item of items) {
    if (item.type !== "user_message" || item.ordinal === undefined) continue;
    if (item.threadId !== undefined && item.threadId !== threadId) continue;
    if (earliest !== null && earliest.ordinal <= item.ordinal) continue;
    earliest = { ordinal: item.ordinal, sender: item.senderThreadId ?? null };
  }
  return earliest;
}

/** `undefined` when the first message could not be reached within the page budget. */
const readFirstSender = createEnvironmentCommand(connectionAtomRuntime, {
  label: "kud:canvas:first-message-sender",
  execute: Effect.fn("kud.canvas.readFirstSender")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const { threadId } = input;
    const snapshotEndpoint = {
      params: { threadId },
      query: { compactTurnItems: "1", dedupeBodies: "1", compactIds: "1", deferWork: "1" },
    };
    const snapshot = yield* executeConnectedEnvironmentHttpRequest({
      group: "orchestration",
      method: "GET",
      url: (urls) => urls.threadBoundedSnapshot(snapshotEndpoint),
      timeoutMs: 10_000,
      request: ({ client, headers }) =>
        client.threadBoundedSnapshot({
          ...snapshotEndpoint,
          headers: withOrchestrationProtocolHeader(headers),
        }),
    });
    let earliest = earliestUserMessage(
      [
        ...snapshot.projection.turnItems,
        ...snapshot.projection.visibleTurnItems
          .filter((row) => row.visibility === "local")
          .map((row) => row.item),
      ],
      threadId,
      null,
    );
    let cursor = snapshot.hasMoreHistory ? snapshot.historyCursor : null;
    for (let page = 0; cursor !== null && page < MAX_HISTORY_PAGES; page += 1) {
      const pageEndpoint = {
        params: { threadId },
        query: { cursor, compactIds: "1", deferWork: "1", view: "conversation" as const },
      };
      const history = yield* executeConnectedEnvironmentHttpRequest({
        group: "orchestration",
        method: "GET",
        url: (urls) => urls.threadHistoryPage(pageEndpoint),
        timeoutMs: 10_000,
        request: ({ client, headers }) =>
          client.threadHistoryPage({
            ...pageEndpoint,
            headers: withOrchestrationProtocolHeader(headers),
          }),
      });
      earliest = earliestUserMessage(
        history.items
          .filter((row) => row.visibility === "local")
          .map((row) => row.item as TurnItemLike),
        threadId,
        earliest,
      );
      cursor = history.hasMoreHistory ? history.nextCursor : null;
    }
    if (cursor !== null) return undefined;
    return earliest?.sender ?? null;
  }),
});

let answers: Map<string, ThreadId | null> | null = null;
let published: StartedByAnswers = new Map();
const listeners = new Set<() => void>();
const queued: Array<{ readonly key: string; readonly ref: ReturnType<typeof scopeThreadRef> }> = [];
const requested = new Set<string>();
let inFlight = 0;
let flushTimer: number | null = null;

function loadAnswers(): Map<string, ThreadId | null> {
  if (answers !== null) return answers;
  answers = new Map();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string")
          answers.set(key, value.length > 0 ? (value as ThreadId) : null);
      }
    }
  } catch {
    // A convenience cache; answers are read again when it is missing.
  }
  published = new Map(answers);
  return answers;
}

function persist(current: ReadonlyMap<string, ThreadId | null>) {
  try {
    const entries = [...current].slice(-STORAGE_LIMIT);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries.map(([key, value]) => [key, value ?? ""]))),
    );
  } catch {
    // Storage can be full or blocked; the in-memory answers still hold for this session.
  }
}

function flush() {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  const current = loadAnswers();
  if (published.size === current.size) return;
  published = new Map(current);
  persist(current);
  for (const listener of listeners) listener();
}

function scheduleFlush() {
  if (inFlight === 0 && queued.length === 0) {
    flush();
    return;
  }
  flushTimer ??= window.setTimeout(flush, FLUSH_INTERVAL_MS);
}

function pump() {
  while (inFlight < CONCURRENCY && queued.length > 0) {
    const next = queued.shift()!;
    inFlight += 1;
    void runAtomCommand(
      appAtomRegistry,
      readFirstSender,
      { environmentId: next.ref.environmentId, input: { threadId: next.ref.threadId } },
      { reportFailure: false, reportDefect: false },
    )
      .then((result) => {
        if (result._tag === "Success" && result.value !== undefined) {
          loadAnswers().set(next.key, result.value);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight -= 1;
        pump();
        scheduleFlush();
      });
  }
}

function request(refs: ReadonlyArray<ReturnType<typeof scopeThreadRef>>) {
  const current = loadAnswers();
  for (const ref of refs) {
    const key = scopedThreadKey(ref);
    // Failures are not retried this session; the next visit asks again.
    if (current.has(key) || requested.has(key)) continue;
    requested.add(key);
    queued.push({ key, ref });
  }
  pump();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): StartedByAnswers {
  loadAnswers();
  return published;
}

/** Threads an agent may have launched: made by an agent or through MCP, with no engine parent. */
export function isStartedByCandidate(thread: EnvironmentThreadShell): boolean {
  if (thread.forkedFrom !== null || thread.lineage.parentThreadId !== null) return false;
  const source = thread.source;
  return (
    source.createdBy !== "user" ||
    source.creationSource === "mcp" ||
    source.creationSource === "server"
  );
}

/** The launching thread of every thread whose first message is known, cached or read. */
export function useStartedByAnswers(): StartedByAnswers {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Asks for the first message of the `candidates` not answered yet, in the order given (newest
 * trees first), a few at a time. Answers reach `useStartedByAnswers` in batches.
 */
export function useRequestStartedBy(
  current: StartedByAnswers,
  candidates: ReadonlyArray<EnvironmentThreadShell>,
): void {
  const wantedKey = candidates
    .slice(0, MAX_CANDIDATES)
    .filter(
      (candidate) =>
        !current.has(scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id))),
    )
    .map((candidate) => JSON.stringify([candidate.environmentId, candidate.id]))
    .join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the first message of agent threads on screen whose launcher is not cached yet
  useEffect(() => {
    if (wantedKey === "") return;
    request(
      wantedKey.split("\n").map((entry) => {
        const [environmentId, threadId] = JSON.parse(entry) as [EnvironmentId, ThreadId];
        return scopeThreadRef(environmentId, threadId);
      }),
    );
  }, [wantedKey]);
}
