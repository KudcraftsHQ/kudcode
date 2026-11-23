// Kud Code: fork from an automatic brief. Fork the parent, ask the child for a brief (native fork,
// so it reads the parent's cached history), then send brief + direction with `freshContext: true`.
// Jobs live at module level so they survive navigation; client-side only, existing commands.
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { request } from "@t3tools/client-runtime/rpc";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  type AtomCommandResult,
  createEnvironmentCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell, waitForThreadShell } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { environmentThreadDetails, threadEnvironment } from "~/state/threads";
import { kudParentTag, KUD_PARENT_TAG_PREFIX, readKudParentTag } from "../shared/contract";
import { briefRequestText, continueFromBriefText, titleFromDirection } from "./briefPrompts";

/** A brief is one short answer; past this the provider is stuck or waiting on the user. */
const BRIEF_TIMEOUT_MS = 10 * 60_000;
const SHELL_TIMEOUT_MS = 10_000;
/** `thread.tag.set` takes tags of at most 64 characters. */
const THREAD_TAG_MAX_LENGTH = 64;

const dispatchCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "kud:fork:dispatch",
  execute: (command: OrchestrationV2Command) =>
    request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command),
});

const newCommandId = () => CommandId.make(randomUUID());

function failureMessage(result: AtomCommandResult<unknown, unknown>, fallback: string): string {
  if (result._tag !== "Failure") return fallback;
  return thrownErrorMessage(squashAtomCommandFailure(result), m) ?? fallback;
}

async function dispatch(environmentId: EnvironmentId, command: OrchestrationV2Command) {
  const result = await runAtomCommand(
    appAtomRegistry,
    dispatchCommand,
    { environmentId, input: command },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) throw new Error(m(msg("Cancelled.")));
    throw new Error(failureMessage(result, m(msg("The server rejected the command."))));
  }
}

function assertCanOperate(environmentId: EnvironmentId) {
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    throw new Error(m(msg("This connection cannot change threads or projects.")));
  }
}

function supportsFreshContext(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .freshContext === true
  );
}

function notify(title: string, description: string, type: "error" | "warning" = "error") {
  toastManager.add({ type, title, description });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : m(msg("Something went wrong."));
}

// One background job per child thread. A second request for the same child is ignored.
const runningJobs = new Map<string, Promise<void>>();

function runJob(child: ScopedThreadRef, job: () => Promise<void>) {
  const key = threadKey(child);
  if (runningJobs.has(key)) return;
  const promise = job()
    .catch((error: unknown) => {
      notify(m(msg("The fork could not start from a brief")), errorText(error));
    })
    .finally(() => runningJobs.delete(key));
  runningJobs.set(key, promise);
}

async function forkThread(input: {
  readonly parent: ScopedThreadRef;
  readonly runId: string | undefined;
  readonly title: string | null;
}): Promise<EnvironmentThreadShell> {
  const childId = newThreadId();
  const child = scopeThreadRef(input.parent.environmentId, childId);
  await dispatch(input.parent.environmentId, {
    type: "thread.fork",
    commandId: newCommandId(),
    createdBy: "user",
    creationSource: "web",
    sourceThreadId: input.parent.threadId,
    targetThreadId: childId,
    sourcePoint:
      input.runId === undefined
        ? { type: "latest_stable" }
        : { type: "run", runId: input.runId as RunId },
    ...(input.title === null ? {} : { title: input.title }),
  });
  const shell = (await waitForThreadShell(child, SHELL_TIMEOUT_MS)) ? readThreadShell(child) : null;
  if (shell === null) {
    throw new Error(
      m(
        msg(
          "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
        ),
      ),
    );
  }
  return shell;
}

async function sendMessage(input: {
  readonly child: EnvironmentThreadShell;
  readonly messageId: MessageId;
  readonly text: string;
  readonly freshContext: boolean;
  readonly interactionMode: EnvironmentThreadShell["interactionMode"];
}) {
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    {
      environmentId: input.child.environmentId,
      input: {
        threadId: input.child.id,
        message: { messageId: input.messageId, role: "user", text: input.text, attachments: [] },
        runtimeMode: input.child.runtimeMode,
        interactionMode: input.interactionMode,
        ...(input.freshContext ? { freshContext: true } : {}),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    throw new Error(failureMessage(result, m(msg("The message could not be sent."))));
  }
}

type BriefOutcome =
  | { readonly type: "brief"; readonly text: string }
  | { readonly type: "failed"; readonly status: OrchestrationV2Run["status"] | "empty" }
  | { readonly type: "timeout" };

const FAILED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

function readBrief(
  thread: EnvironmentThread | null,
  briefMessageId: MessageId,
): BriefOutcome | null {
  if (thread === null) return null;
  const run = thread.projection.runs.find(
    (candidate) => candidate.userMessageId === briefMessageId,
  );
  if (run === undefined) return null;
  if (FAILED_RUN_STATUSES.has(run.status)) return { type: "failed", status: run.status };
  if (run.status !== "completed") return null;
  const replies = thread.projection.messages.filter(
    (message) => message.runId === run.id && message.role === "assistant",
  );
  // The run can complete a moment before its last message stops streaming.
  if (replies.some((message) => message.streaming)) return null;
  const text = replies
    .map((message) => message.text.trim())
    .filter((value) => value.length > 0)
    .at(-1);
  return text === undefined ? { type: "failed", status: "empty" } : { type: "brief", text };
}

/** Follows the child's live thread (the stream the chat view reads) until the brief run ends. */
function waitForBrief(child: ScopedThreadRef, briefMessageId: MessageId): Promise<BriefOutcome> {
  const atom = environmentThreadDetails.threadAtom(child);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (outcome: BriefOutcome) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      unsubscribe?.();
      resolve(outcome);
    };
    const check = (thread: EnvironmentThread | null) => {
      const outcome = readBrief(thread, briefMessageId);
      if (outcome !== null) finish(outcome);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check, { immediate: true });
    if (settled) {
      unsubscribe();
      return;
    }
    timeoutId = globalThis.setTimeout(() => finish({ type: "timeout" }), BRIEF_TIMEOUT_MS);
  });
}

function briefFailureMessage(outcome: Exclude<BriefOutcome, { type: "brief" }>): string {
  if (outcome.type === "timeout") {
    return m(msg("The brief did not finish in time. Open the fork to see where it stopped."));
  }
  if (outcome.status === "empty") {
    return m(msg("The brief came back empty. Open the fork and write the first message yourself."));
  }
  return m(
    msg("The brief run did not complete. Open the fork and write the first message yourself."),
  );
}

async function requestBrief(child: EnvironmentThreadShell, direction: string | null) {
  const briefMessageId = newMessageId();
  // Plan mode would answer with a plan to approve; a brief is a plain reply.
  await sendMessage({
    child,
    messageId: briefMessageId,
    text: briefRequestText(direction),
    freshContext: false,
    interactionMode: "default",
  });
  const outcome = await waitForBrief(scopeThreadRef(child.environmentId, child.id), briefMessageId);
  if (outcome.type !== "brief") throw new Error(briefFailureMessage(outcome));
  return outcome.text;
}

/** Starts a child on the brief. Servers that reject the fresh send get a plain one. */
async function startFromBrief(child: EnvironmentThreadShell, brief: string, direction: string) {
  const text = continueFromBriefText(brief, direction);
  const base = { child, text, interactionMode: child.interactionMode } as const;
  try {
    await sendMessage({ ...base, messageId: newMessageId(), freshContext: true });
  } catch {
    await sendMessage({ ...base, messageId: newMessageId(), freshContext: false });
    notify(
      m(msg("The fork kept the parent's history")),
      m(
        msg(
          "This server could not start it with fresh context, so the brief was sent as a normal message.",
        ),
      ),
      "warning",
    );
  }
}

/** Servers without fresh context would keep the whole history anyway, so the brief is skipped. */
async function startWithoutBrief(child: EnvironmentThreadShell, direction: string) {
  await sendMessage({
    child,
    messageId: newMessageId(),
    text: direction.trim(),
    freshContext: false,
    interactionMode: child.interactionMode,
  });
  notify(
    m(msg("The fork kept the parent's history")),
    m(msg("This server cannot start a thread with fresh context, so no brief was made.")),
    "warning",
  );
}

function refOf(shell: EnvironmentThreadShell): ScopedThreadRef {
  return scopeThreadRef(shell.environmentId, shell.id);
}

function requireDirection(direction: string): string {
  const trimmed = direction.trim();
  if (trimmed.length === 0) throw new Error(m(msg("Describe where the fork should go.")));
  return trimmed;
}

export async function forkWithBrief(input: {
  readonly thread: ScopedThreadRef;
  readonly runId?: string;
  readonly direction: string;
}): Promise<ScopedThreadRef> {
  const direction = requireDirection(input.direction);
  assertCanOperate(input.thread.environmentId);
  const child = await forkThread({
    parent: input.thread,
    runId: input.runId,
    title: titleFromDirection(direction),
  });
  runJob(refOf(child), async () => {
    if (!supportsFreshContext(child.environmentId)) {
      await startWithoutBrief(child, direction);
      return;
    }
    const brief = await requestBrief(child, direction);
    await startFromBrief(child, brief, direction);
  });
  return refOf(child);
}

export async function exploreDirections(input: {
  readonly thread: ScopedThreadRef;
  readonly runId?: string;
  readonly directions: ReadonlyArray<string>;
}): Promise<ReadonlyArray<ScopedThreadRef>> {
  const directions = input.directions.map((value) => value.trim()).filter((value) => value.length);
  if (directions.length === 0) {
    throw new Error(m(msg("Describe where the fork should go.")));
  }
  assertCanOperate(input.thread.environmentId);
  const [firstDirection, ...otherDirections] = directions as [string, ...string[]];
  const first = await forkThread({
    parent: input.thread,
    runId: input.runId,
    title: titleFromDirection(firstDirection),
  });
  // Every sibling forks from the run the first child forked from, even when the parent moved on.
  const runId =
    input.runId ?? (first.forkedFrom?.type === "run" ? first.forkedFrom.runId : undefined);
  const others = await Promise.allSettled(
    otherDirections.map(async (direction) => ({
      shell: await forkThread({
        parent: input.thread,
        runId,
        title: titleFromDirection(direction),
      }),
      direction,
    })),
  );
  const children = [{ shell: first, direction: firstDirection }];
  for (const other of others) {
    if (other.status === "fulfilled") children.push(other.value);
    else notify(m(msg("A fork could not be created")), errorText(other.reason));
  }
  runJob(refOf(first), async () => {
    if (!supportsFreshContext(first.environmentId)) {
      await Promise.all(children.map((child) => startWithoutBrief(child.shell, child.direction)));
      return;
    }
    const brief = await requestBrief(first, null);
    const results = await Promise.allSettled(
      children.map((child) => startFromBrief(child.shell, brief, child.direction)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  });
  return children.map((child) => refOf(child.shell));
}

export async function reportBack(child: ScopedThreadRef): Promise<void> {
  assertCanOperate(child.environmentId);
  const shell = readThreadShell(child);
  const parentId = shell?.lineage.parentThreadId ?? null;
  if (shell === null || parentId === null || shell.lineage.relationshipToParent !== "fork") {
    throw new Error(m(msg("Only a fork can report back to its parent.")));
  }
  await dispatch(child.environmentId, {
    type: "thread.merge_back",
    commandId: newCommandId(),
    createdBy: "user",
    creationSource: "web",
    sourceThreadId: child.threadId,
    targetThreadId: parentId,
    sourcePoint: { type: "latest_stable" },
  });
}

/** Sets or clears the `kud:parent:` tag, leaving the thread's other tags alone. */
export async function setManualParent(
  child: ScopedThreadRef,
  parent: ScopedThreadRef | null,
): Promise<void> {
  assertCanOperate(child.environmentId);
  if (parent !== null) {
    if (parent.environmentId !== child.environmentId) {
      throw new Error(m(msg("A thread can only be linked under a thread on the same machine.")));
    }
    if (parent.threadId === child.threadId) {
      throw new Error(m(msg("A thread cannot be linked under itself.")));
    }
    if (readKudParentTag(readThreadShell(parent)?.source.tags) === child.threadId) {
      throw new Error(m(msg("These threads are already linked the other way round.")));
    }
  }
  const nextTag = parent === null ? null : kudParentTag(parent.threadId as ThreadId);
  if (nextTag !== null && nextTag.length > THREAD_TAG_MAX_LENGTH) {
    throw new Error(m(msg("This parent's id is too long to store as a link.")));
  }
  const currentTags = readThreadShell(child)?.source.tags ?? [];
  const staleTags = currentTags.filter(
    (tag) => tag.startsWith(KUD_PARENT_TAG_PREFIX) && tag !== nextTag,
  );
  for (const tag of staleTags) {
    await dispatch(child.environmentId, {
      type: "thread.tag.set",
      commandId: newCommandId(),
      threadId: child.threadId,
      tag,
      tagged: false,
    });
  }
  if (nextTag !== null && !currentTags.includes(nextTag)) {
    await dispatch(child.environmentId, {
      type: "thread.tag.set",
      commandId: newCommandId(),
      threadId: child.threadId,
      tag: nextTag,
      tagged: true,
    });
  }
}
