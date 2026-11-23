import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { T, useGT, useMessages } from "gt-react";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EllipsisIcon,
  GitBranchIcon,
  LinkIcon,
  MessagesSquareIcon,
  PlusIcon,
  RocketIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import {
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
} from "../../components/Sidebar.logic";
import {
  ChangeRequestStatusIcon,
  linkedPullRequestSnapshotStatus,
  prStatusIndicator,
  ThreadStatusLabel,
} from "../../components/ThreadStatusIndicators";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { useCanvasInteractions } from "./canvasContext";
import type { CanvasRelation, SameWorkChip, ThreadFlowNode } from "./canvasGraph.logic";

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

const RELATION_ICON: Record<CanvasRelation, LucideIcon> = {
  fork: GitBranchIcon,
  "side-chat": MessagesSquareIcon,
  subagent: BotIcon,
  "workflow-step": WorkflowIcon,
  linked: LinkIcon,
  "started-by": RocketIcon,
};

function previewLine(text: string | undefined): string | null {
  if (text === undefined) return null;
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

function RelationMarker({ relation }: { readonly relation: CanvasRelation }) {
  const gt = useGT();
  const Icon = RELATION_ICON[relation];
  const label =
    relation === "fork"
      ? gt("Fork")
      : relation === "side-chat"
        ? gt("Side chat")
        : relation === "subagent"
          ? gt("Subagent")
          : relation === "workflow-step"
            ? gt("Workflow step")
            : relation === "started-by"
              ? gt("Started by an agent in the parent thread")
              : gt("Linked by hand");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="relative z-10 mt-0.5 inline-flex shrink-0 text-muted-foreground"
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Sits on the card's top edge, outside its fixed height, so the tree keeps its spacing. */
function SameWorkTab({
  chip,
  threadKey,
}: {
  readonly chip: SameWorkChip;
  readonly threadKey: string;
}) {
  const gt = useGT();
  const interactions = useCanvasInteractions();
  const first = chip.others[0]?.title ?? "";
  const more = chip.others.length - 1;
  const label =
    chip.kind === "pr"
      ? more > 0
        ? gt("Same PR as “{title}” and {count} more", { title: first, count: more })
        : gt("Same PR as “{title}”", { title: first })
      : more > 0
        ? gt("Same branch as “{title}” and {count} more", { title: first, count: more })
        : gt("Same branch as “{title}”", { title: first });
  const Icon = chip.kind === "pr" ? PullRequestGlyph.pullRequest : GitBranchIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="absolute -top-2.5 left-3 z-10 inline-flex h-5 max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-full border bg-background px-1.5 text-3xs text-muted-foreground leading-4 outline-hidden hover:border-ring/50 hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
            onClick={() =>
              interactions.highlight([threadKey, ...chip.others.map((other) => other.key)])
            }
          />
        }
      >
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function PullRequestBadge({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const m = useMessages();
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests);
  const status = link === null ? null : linkedPullRequestSnapshotStatus(link);
  const number = link?.number ?? thread.linkedPullRequest?.number ?? null;
  if (number === null) return null;
  const indicator =
    status === null ? null : prStatusIndicator(status.pr, status.sourceControlProvider, m);
  const label = indicator?.tooltip ?? `#${number}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={cn(
              "relative z-10 inline-flex shrink-0 items-center gap-0.5 tabular-nums",
              indicator?.colorClass ?? "text-muted-foreground",
            )}
          />
        }
      >
        <ChangeRequestStatusIcon
          state={status?.pr?.state ?? "open"}
          isDraft={status?.pr?.isDraft === true}
          className="size-3"
        />
        <span className="text-secondary-label">{number}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadNode(node: NodeProps<ThreadFlowNode>) {
  const gt = useGT();
  const interactions = useCanvasInteractions();
  const { item, subagentCount, subagentsExpanded, projectTitle, outline } = node.data;
  const thread = item.thread;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const nowMinute = useNowMinute();
  const [menuOpen, setMenuOpen] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);

  const status = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
    },
  });
  const provider = interactions.providerFor(thread);
  const modelSlug = thread.modelSelection.model;
  const model = provider?.models.find((entry) => entry.slug === modelSlug);
  const modelLabel = model?.shortName ?? model?.name ?? modelSlug;
  const age = formatRelativeTimeLabel(thread.updatedAt, Date.parse(`${nowMinute}Z`));
  // Servers send no message summary in shells yet, so the goal or last error stands in.
  const preview = item.pending
    ? gt("Creating thread…")
    : (previewLine(thread.source.latestVisibleMessage?.text) ??
      previewLine(thread.goal?.objective) ??
      previewLine(thread.runtime?.lastError ?? undefined));

  const cancelPress = () => {
    if (press.current !== null) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || item.pending) return;
    cancelPress();
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        swallowClick.current = true;
        setMenuOpen(true);
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = press.current;
    if (start === null) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) {
      cancelPress();
    }
  };

  return (
    <div
      className={cn(
        "group/node relative flex h-28 w-72 select-none flex-col gap-1 rounded-xl border bg-card p-3 text-card-foreground shadow-xs transition-colors",
        "hover:border-ring/50 has-focus-visible:border-ring has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring/40",
        node.selected && "border-ring ring-2 ring-inset ring-ring/40",
        item.settled && !node.selected && "bg-muted/40 text-muted-foreground",
        item.pending && "border-dashed",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        cancelPress();
        if (!item.pending) setMenuOpen(true);
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        data-kud-canvas-handle=""
      />
      {node.data.sameWork === undefined ? null : (
        <SameWorkTab chip={node.data.sameWork} threadKey={threadKey} />
      )}
      <div className="flex min-w-0 items-start gap-1.5">
        {item.relation === null ? null : <RelationMarker relation={item.relation} />}
        <button
          type="button"
          className="min-w-0 flex-1 text-left font-medium text-sm leading-5 outline-hidden after:absolute after:inset-0 after:rounded-xl"
          disabled={item.pending}
          onClick={() => interactions.openThread(threadKey)}
        >
          <span className={preview === null ? "line-clamp-2" : "line-clamp-1"}>{thread.title}</span>
        </button>
        <span className={cn("relative z-10 -my-1 -me-1.5 shrink-0", item.pending && "invisible")}>
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              render={<Button variant="ghost-muted" size="icon-xs" />}
              aria-label={gt("Thread actions")}
              // Node dragging swallows mousedown, which the trigger would open on; click still lands.
              onClick={() => setMenuOpen(true)}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => interactions.openDialog("child", threadKey)}>
                <PlusIcon />
                <T>New child thread…</T>
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => interactions.openThread(threadKey)}>
                <T>Open thread</T>
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => interactions.openDialog("fork", threadKey)}>
                <GitBranchIcon />
                <T>Fork with brief…</T>
              </MenuItem>
              <MenuItem onClick={() => interactions.openDialog("explore", threadKey)}>
                <WorkflowIcon />
                <T>Explore directions…</T>
              </MenuItem>
              {item.relation === "fork" ? (
                <MenuItem onClick={() => interactions.reportBack(threadKey)}>
                  <T>Report back to parent</T>
                </MenuItem>
              ) : null}
              {item.engineRoot || item.relation === "linked" ? <MenuSeparator /> : null}
              {item.engineRoot ? (
                <MenuItem onClick={() => interactions.openDialog("link", threadKey)}>
                  <LinkIcon />
                  <T>Link under…</T>
                </MenuItem>
              ) : null}
              {item.relation === "linked" ? (
                <MenuItem onClick={() => interactions.unlink(threadKey)}>
                  <T>Unlink</T>
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </span>
      </div>
      {preview === null ? null : (
        <p className="truncate text-muted-foreground text-xs leading-4">{preview}</p>
      )}
      <div className="mt-auto flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
        {status === null ? null : <ThreadStatusLabel status={status} />}
        {projectTitle === undefined ? null : (
          <span className="max-w-24 shrink-0 truncate font-medium text-secondary-label">
            {projectTitle}
          </span>
        )}
        <span className="inline-flex min-w-0 flex-1 items-center gap-1">
          {provider === null ? null : (
            <ProviderInstanceIcon
              driverKind={provider.driverKind}
              displayName={provider.displayName}
              acpRegistryAgentId={provider.acpRegistryAgentId}
              acpRegistryIconUrl={provider.acpRegistryIconUrl}
              iconClassName="size-3 shrink-0 opacity-70"
            />
          )}
          <span className="truncate">{modelLabel}</span>
        </span>
        <PullRequestBadge thread={thread} />
        {subagentCount > 0 ? (
          <span className="relative z-10 shrink-0">
            <Button
              variant="outline"
              size="micro"
              aria-expanded={subagentsExpanded}
              aria-label={
                subagentsExpanded
                  ? gt("Hide {count} subagents", { count: subagentCount })
                  : gt("Show {count} subagents", { count: subagentCount })
              }
              onClick={() => interactions.toggleSubagents(threadKey)}
            >
              <BotIcon />
              {subagentCount}
              {subagentsExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </Button>
          </span>
        ) : null}
        <span className="shrink-0 tabular-nums">{age}</span>
      </div>
      {item.pending ? null : (
        <span
          className={cn(
            // A solid backdrop, so the edge it sits on never shows through the outline button.
            "absolute z-10 rounded-full bg-background",
            outline
              ? "bottom-0 left-4 -translate-x-1/2 translate-y-3/4"
              : "top-1/2 right-0 translate-x-1/2 -translate-y-1/2",
            // Hover only where there is hover; a selected card always shows it, touch included.
            // In the outline it hangs a little lower, clear of the footer line.
            node.selected ? "visible" : "invisible group-hover/node:visible",
          )}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm-pill"
                  aria-label={gt("New child thread")}
                  onClick={() => interactions.openDialog("child", threadKey)}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side={outline ? "bottom" : "right"}>
              <T>New child thread</T>
            </TooltipPopup>
          </Tooltip>
        </span>
      )}
      <Handle
        type="source"
        position={outline ? Position.Bottom : Position.Right}
        className={outline ? "left-4" : undefined}
        isConnectable={false}
        data-kud-canvas-handle=""
      />
    </div>
  );
}
