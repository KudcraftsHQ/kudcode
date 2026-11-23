import type { NodeProps } from "@xyflow/react";
import { useGT } from "gt-react";
import { GitBranchIcon } from "lucide-react";

import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import type { SameWorkFlowNode } from "./canvasGraph.logic";

// Below this the outline is one card wide, and the label keeps only the number or branch.
const TITLE_MIN_WIDTH = 400;

/** A soft outline behind threads that work on one pull request or one worktree branch. */
export function SameWorkNode(node: NodeProps<SameWorkFlowNode>) {
  const gt = useGT();
  const { kind, number, title, branch } = node.data;
  const Icon = kind === "pr" ? PullRequestGlyph.pullRequest : GitBranchIcon;
  const name =
    kind === "pr"
      ? number === null
        ? gt("Same pull request")
        : title !== null && node.width !== undefined && node.width >= TITLE_MIN_WIDTH
          ? `#${number} ${title}`
          : `#${number}`
      : (branch ?? gt("Same branch"));
  return (
    <div
      aria-hidden
      className="pointer-events-none relative size-full rounded-2xl border border-primary/20 bg-primary/[0.035]"
    >
      <span className="absolute -top-2.5 left-3 inline-flex h-5 max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-full border border-primary/20 bg-background px-1.5 text-3xs text-muted-foreground leading-4">
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{name}</span>
      </span>
    </div>
  );
}
