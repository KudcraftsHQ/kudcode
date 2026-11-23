import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "@xyflow/react";
import { useGT } from "gt-react";
import type { CSSProperties } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { CanvasRelation, LineageFlowEdge } from "./canvasGraph.logic";

const BEND_OFFSET = 20;

// Solid for forks and agent-started threads; the rest are told apart by their dash.
const EDGE_STYLE: Record<CanvasRelation, CSSProperties> = {
  fork: {},
  "started-by": {},
  "side-chat": { strokeDasharray: "8 4" },
  subagent: { strokeDasharray: "3 4" },
  "workflow-step": { strokeDasharray: "3 4" },
  linked: { strokeDasharray: "1 5", strokeLinecap: "round", strokeWidth: 2 },
};

export function LineageEdge(edge: EdgeProps<LineageFlowEdge>) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  // The bend sits next to the parent, so each child gets its own straight run for the label.
  const bendX = edge.sourceX + BEND_OFFSET;
  const [path] = getSmoothStepPath({
    sourceX: edge.sourceX,
    sourceY: edge.sourceY,
    sourcePosition: edge.sourcePosition,
    targetX: edge.targetX,
    targetY: edge.targetY,
    targetPosition: edge.targetPosition,
    borderRadius: 12,
    centerX: bendX,
  });
  const labelX = (bendX + edge.targetX) / 2;
  const labelY = edge.targetY;
  const relation = edge.data?.relation ?? "fork";
  const forkedAt =
    edge.data === undefined
      ? ""
      : formatRelativeTimeLabel(edge.data.childCreatedAt, Date.parse(`${nowMinute}Z`));
  // In the phone outline the elbow is too short for a label; the card's marker says the same.
  const outline = edge.sourcePosition === Position.Bottom;
  const label = outline
    ? null
    : relation === "fork"
      ? forkedAt.length > 0
        ? gt("Forked {age}", { age: forkedAt })
        : gt("Forked")
      : relation === "side-chat"
        ? gt("Side chat")
        : relation === "linked"
          ? gt("Linked")
          : relation === "started-by"
            ? gt("Started by agent")
            : null;
  return (
    <>
      <BaseEdge id={edge.id} path={path} style={EDGE_STYLE[relation]} />
      {label === null ? null : (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute whitespace-nowrap rounded-full border bg-background px-1.5 text-3xs text-muted-foreground leading-4"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
