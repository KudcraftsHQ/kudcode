// Kud Code: the text a forked child is sent. These go to the agent, not to the UI, so they stay
// English like upstream's other agent-facing prompts.

const BRIEF_WORD_LIMIT = 250;
const TITLE_MAX_LENGTH = 60;

/** The child's first turn: runs on the provider's native fork, so it sees the parent's history. */
export function briefRequestText(direction: string | null): string {
  const lines = [
    "Write a handoff brief of this thread so far. A fresh agent will receive it as its only context: it cannot see this conversation, the tools you used or their output.",
    "",
    "Do not do any work. Do not call tools, run commands or edit files. Reply with the brief and nothing else.",
    "",
    `Keep it under ${BRIEF_WORD_LIMIT} words, plain text, in these sections:`,
    "Goal: what this thread is trying to achieve and for whom.",
    "Settled: decisions made and work already done, with the reason where it matters.",
    "Open: the question or next step that is still open.",
    "References: the files, paths, branches, commands, links and ids a newcomer needs, written out exactly.",
    "",
    "Write for a capable engineer who has never seen this thread. No preamble, no closing remarks.",
  ];
  if (direction !== null) {
    lines.push("", "The new agent will take this direction, so favour what it needs:", direction);
  }
  return lines.join("\n");
}

/** The child's real first message, sent with fresh context so the brief is all it carries. */
export function continueFromBriefText(brief: string, direction: string): string {
  return [
    "You are continuing a forked thread. Its earlier history is not available to you; the brief below, written by the agent that worked on the parent thread, is your context.",
    "",
    "Context from the parent:",
    brief.trim(),
    "",
    "Your task:",
    direction.trim(),
  ].join("\n");
}

/** A short thread title from the user's direction: its first line, cut at a word boundary. */
export function titleFromDirection(direction: string): string | null {
  const firstLine = direction.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  if (firstLine.length === 0) return null;
  if (firstLine.length <= TITLE_MAX_LENGTH) return firstLine;
  const cut = firstLine.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > TITLE_MAX_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}
