// Kud Code: "Fork with brief..." and "Explore directions..." beside upstream's "Fork from this
// response" on an assistant message. Rendered by one line in TimelineAssistantRows.tsx.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { GitBranchPlusIcon, SplitIcon } from "lucide-react";
import { use, useState } from "react";

import { TimelineRowCtx, type TimelineRow } from "~/components/chat/timelineRowContext";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useV2ItemSupport } from "~/state/v2ItemSupport";
import { buildThreadRouteParams } from "~/threadRoutes";
import { KudForkDirectionDialog, type KudForkDirectionMode } from "./KudForkDirectionDialog";
import { useKudForkActions } from "./useKudForkActions";

type ProjectedItem = NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;

export function KudTimelineForkActions({
  projectedItem,
}: {
  readonly projectedItem: ProjectedItem;
}) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const navigate = useNavigate();
  const actions = useKudForkActions();
  const [mode, setMode] = useState<KudForkDirectionMode | null>(null);
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  // Same gate as upstream's fork button: absent `onForkFromRun` means a guest view.
  if (!canFork || ctx.onForkFromRun === undefined || projectedItem.item.runId === null) return null;
  const runId = projectedItem.item.runId;
  const thread = scopeThreadRef(ctx.activeThreadEnvironmentId, projectedItem.sourceThreadId);

  const submit = (directions: ReadonlyArray<string>) => {
    if (mode === null) return;
    setBusy(true);
    const started =
      mode === "single"
        ? actions
            .forkWithBrief({ thread, runId, direction: directions[0] ?? "" })
            .then((child) => [child])
        : actions.exploreDirections({ thread, runId, directions });
    void started
      .then(async (children) => {
        setMode(null);
        const first = children[0];
        if (first === undefined) return;
        await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(first) });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: gt("The fork could not be created"),
          description: error instanceof Error ? error.message : gt("Something went wrong."),
        });
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={gt("Fork with a brief")}
                  />
                }
              />
            }
          >
            <GitBranchPlusIcon className={cn("size-3", busy && "animate-pulse")} />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <T>Fork with a brief</T>
          </TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="start">
          <MenuItem onClick={() => setMode("single")}>
            <GitBranchPlusIcon />
            <T>Fork with brief...</T>
          </MenuItem>
          <MenuItem onClick={() => setMode("explore")}>
            <SplitIcon />
            <T>Explore directions...</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
      <KudForkDirectionDialog
        mode={mode ?? "single"}
        open={mode !== null}
        busy={busy}
        onOpenChange={(next) => {
          if (!next && !busy) setMode(null);
        }}
        onSubmit={submit}
      />
    </>
  );
}
