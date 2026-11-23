// Kud Code: a new child thread from a canvas card. A fresh thread (not a fork) in the parent's
// project, machine, workspace and model, linked under the parent in the link store. With a brief,
// it is `forkWithBrief` instead, so the brief path lives in one place.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { newMessageId, newThreadId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import {
  assertCanOperate,
  dispatch,
  errorText,
  failureMessage,
  forkWithBrief,
  newCommandId,
  notify,
  setManualParent,
} from "./forkJobs";

// The server's own name for a thread without messages: its first message renames it.
const EMPTY_THREAD_TITLE = "New thread";

/** The user's words, then a footer the agent can follow to read the parent. */
function firstMessageText(message: string, parent: ScopedThreadRef): string {
  const link = formatThreadLink({ environmentId: parent.environmentId, threadId: parent.threadId });
  // oxlint-disable-next-line t3code/no-untranslated-copy -- read by the agent, not shown as interface copy
  return `${message}\n\nParent thread: ${link}`;
}

async function launchWithMessage(
  parent: EnvironmentThreadShell,
  child: ScopedThreadRef,
  message: string,
) {
  const createdAt = new Date().toISOString();
  const titleSeed = deriveThreadTitleSeed({ text: message, attachments: [] }, m);
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    {
      environmentId: child.environmentId,
      input: {
        threadId: child.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: firstMessageText(message, scopeThreadRef(parent.environmentId, parent.id)),
          attachments: [],
        },
        modelSelection: parent.modelSelection,
        titleSeed,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        bootstrap: {
          createThread: {
            projectId: parent.projectId,
            title: titleSeed,
            modelSelection: parent.modelSelection,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            branch: parent.branch,
            worktreePath: parent.worktreePath,
            createdAt,
          },
        },
        createdAt,
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    throw new Error(failureMessage(result, m(msg("The thread could not be created."))));
  }
}

/** No message: an idle thread that waits for the user's first one. */
async function createIdle(parent: EnvironmentThreadShell, child: ScopedThreadRef) {
  await dispatch(child.environmentId, {
    type: "thread.create",
    commandId: newCommandId(),
    createdBy: "user",
    creationSource: "web",
    threadId: child.threadId,
    projectId: parent.projectId,
    title: EMPTY_THREAD_TITLE,
    modelSelection: parent.modelSelection,
    runtimeMode: parent.runtimeMode,
    interactionMode: parent.interactionMode,
    branch: parent.branch,
    worktreePath: parent.worktreePath,
  });
}

export async function createChildThread(input: {
  readonly parent: ScopedThreadRef;
  readonly message: string;
  readonly withBrief: boolean;
}): Promise<ScopedThreadRef> {
  const message = input.message.trim();
  if (input.withBrief) return forkWithBrief({ thread: input.parent, direction: message });
  assertCanOperate(input.parent.environmentId);
  const parent = readThreadShell(input.parent);
  if (parent === null) {
    throw new Error(m(msg("The parent thread is not loaded on this client.")));
  }
  const child = scopeThreadRef(input.parent.environmentId, newThreadId());
  // Linked first, so the thread's shell already lands under its parent instead of as a root.
  const linkError = await setManualParent(child, input.parent).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    if (message.length === 0) await createIdle(parent, child);
    else await launchWithMessage(parent, child, message);
  } catch (error) {
    if (linkError === null) void setManualParent(child, null).catch(() => {});
    throw error;
  }
  if (linkError !== null) {
    notify(
      m(msg("The thread was created but not linked")),
      m(
        msg("Link it under its parent with “Link under…”. {reason}", {
          reason: errorText(linkError),
        }),
      ),
      "warning",
    );
  }
  return child;
}
