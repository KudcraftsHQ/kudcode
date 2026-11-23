import type { NodeProps } from "@xyflow/react";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { useCanvasInteractions } from "./canvasContext";
import type { ProjectFlowNode } from "./canvasGraph.logic";

export function ProjectNode(node: NodeProps<ProjectFlowNode>) {
  const gt = useGT();
  const interactions = useCanvasInteractions();
  const { projectKey, title, familyCount, threadCount, collapsed } = node.data;
  const name = title.length > 0 ? title : gt("Project");
  return (
    <div
      className={cn(
        "size-full rounded-2xl border bg-muted/30",
        collapsed ? "border-solid" : "border-dashed",
      )}
    >
      <div className="flex h-12 items-center gap-2 px-3">
        <span className="shrink-0">
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-expanded={!collapsed}
            aria-label={
              collapsed
                ? gt("Expand {project}", { project: name })
                : gt("Collapse {project}", { project: name })
            }
            onClick={() => interactions.toggleProject(projectKey)}
          >
            {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          </Button>
        </span>
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground text-sm">{name}</span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {gt(
            "{families, plural, one {# tree} other {# trees}} · {threads, plural, one {# thread} other {# threads}}",
            {
              families: familyCount,
              threads: threadCount,
            },
          )}
        </span>
      </div>
    </div>
  );
}
