import dagre from "@dagrejs/dagre";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { deriveThreadRelationshipGraph } from "@t3tools/client-runtime/state/thread-relationships";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Position, type Edge, type Node, type NodeHandle, type XYPosition } from "@xyflow/react";

import { readKudParentTag, type KudManualLink } from "../shared/contract";

export type CanvasMode = "tree" | "projects";
export type CanvasRelation =
  | "fork"
  | "side-chat"
  | "subagent"
  | "workflow-step"
  | "linked"
  | "started-by";

export interface CanvasThread {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly parentKey: string | null;
  readonly relation: CanvasRelation | null;
  /** No engine parent, so it can be linked under another thread by hand. */
  readonly engineRoot: boolean;
  readonly settled: boolean;
  readonly createdAtMs: number;
  readonly activityMs: number;
  /** A child being created: shown under its parent until the real thread arrives. */
  readonly pending?: true;
}

export interface CanvasFamily {
  readonly key: string;
  readonly root: CanvasThread;
  /** Parents before children, siblings oldest first. */
  readonly members: ReadonlyArray<CanvasThread>;
  readonly activityMs: number;
  readonly hasUnsettled: boolean;
}

export interface CanvasForest {
  readonly threads: ReadonlyMap<string, CanvasThread>;
  readonly children: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly families: ReadonlyArray<CanvasFamily>;
}

export const projectKeyOf = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `${environmentId}:${projectId}`;

const threadKeyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const millis = (iso: string | null | undefined) => {
  if (iso == null) return 0;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
};

function groupBy<T, K>(items: ReadonlyArray<T>, keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

const isCollapsibleRelation = (relation: CanvasRelation | null) =>
  relation === "subagent" || relation === "workflow-step";

/**
 * Every live thread placed in a tree. The engine's lineage decides parents, the same rule as
 * `deriveThreadRelationshipGraph`. Threads the engine left as roots are then placed by a manual
 * link (the link store, else the `kud:parent:` tag), else by the thread whose agent sent their
 * first message. None of these ever closes a cycle, and each moves the child's whole subtree.
 */
export function buildCanvasForest(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly hiddenKeys: ReadonlySet<string>;
  /** Keyed by `scopedThreadKey` of the child. */
  readonly manualLinks?: ReadonlyMap<string, KudManualLink>;
  /** Keyed by `scopedThreadKey` of the child: the thread whose agent sent its first message. */
  readonly startedBy?: ReadonlyMap<string, ThreadId | null>;
}): CanvasForest {
  const live = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      !input.hiddenKeys.has(threadKeyOf(thread)),
  );
  const byKey = new Map(live.map((thread) => [threadKeyOf(thread), thread] as const));
  const parentOf = new Map<string, { key: string; relation: CanvasRelation }>();

  const byEnvironment = groupBy(live, (thread) => thread.environmentId);
  for (const [environmentId, threads] of byEnvironment) {
    const graph = deriveThreadRelationshipGraph({
      threads: threads.map((thread) => thread.source),
      projection: null,
    });
    for (const edge of graph.edges) {
      if (edge.kind !== "fork" && edge.kind !== "subagent") continue;
      const childKey = scopedThreadKey(scopeThreadRef(environmentId, edge.targetThreadId));
      const parentKey = scopedThreadKey(scopeThreadRef(environmentId, edge.sourceThreadId));
      const child = byKey.get(childKey);
      if (child === undefined || !byKey.has(parentKey)) continue;
      parentOf.set(childKey, {
        key: parentKey,
        relation:
          edge.kind === "subagent"
            ? child.lineage.workflowStep === true
              ? "workflow-step"
              : "subagent"
            : child.lineage.sideChat === true
              ? "side-chat"
              : "fork",
      });
    }
  }

  const engineParentId = (thread: EnvironmentThreadShell) =>
    thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : thread.lineage.parentThreadId;
  const reaches = (fromKey: string, targetKey: string) => {
    const seen = new Set<string>();
    for (let key: string | undefined = fromKey; key !== undefined; key = parentOf.get(key)?.key) {
      if (key === targetKey) return true;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  };
  const attach = (
    key: string,
    thread: EnvironmentThreadShell,
    parentId: ThreadId | null | undefined,
    relation: CanvasRelation,
  ) => {
    if (parentId == null || parentId === thread.id) return false;
    const parentKey = scopedThreadKey(scopeThreadRef(thread.environmentId, parentId));
    if (!byKey.has(parentKey) || reaches(parentKey, key)) return false;
    parentOf.set(key, { key: parentKey, relation });
    return true;
  };
  const unplaced: Array<readonly [string, EnvironmentThreadShell]> = [];
  for (const [key, thread] of byKey) {
    if (engineParentId(thread) !== null) continue;
    const link = input.manualLinks?.get(key);
    const manual =
      link !== undefined && link.environmentId === thread.environmentId
        ? link.parentThreadId
        : readKudParentTag(thread.source.tags);
    if (!attach(key, thread, manual, "linked")) unplaced.push([key, thread]);
  }
  // After every manual link, so a hand-made link is never refused for a cycle a guess made.
  for (const [key, thread] of unplaced) {
    attach(key, thread, input.startedBy?.get(key), "started-by");
  }

  const threads = new Map<string, CanvasThread>();
  for (const [key, thread] of byKey) {
    const parent = parentOf.get(key) ?? null;
    threads.set(key, {
      key,
      thread,
      parentKey: parent?.key ?? null,
      relation: parent?.relation ?? null,
      engineRoot: engineParentId(thread) === null,
      settled: thread.settledOverride === "settled",
      createdAtMs: millis(thread.createdAt),
      activityMs: Math.max(millis(thread.updatedAt), millis(thread.latestUserMessageAt)),
    });
  }

  const children = new Map<string, string[]>();
  for (const item of threads.values()) {
    if (item.parentKey === null) continue;
    const siblings = children.get(item.parentKey);
    if (siblings === undefined) children.set(item.parentKey, [item.key]);
    else siblings.push(item.key);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) =>
        (threads.get(left)?.createdAtMs ?? 0) - (threads.get(right)?.createdAtMs ?? 0),
    );
  }

  const families: CanvasFamily[] = [];
  for (const root of threads.values()) {
    if (root.parentKey !== null) continue;
    const members: CanvasThread[] = [];
    const queue = [root.key];
    while (queue.length > 0) {
      const key = queue.shift()!;
      const item = threads.get(key);
      if (item === undefined) continue;
      members.push(item);
      queue.push(...(children.get(key) ?? []));
    }
    families.push({
      key: root.key,
      root,
      members,
      activityMs: Math.max(...members.map((member) => member.activityMs)),
      // Subagents and workflow steps never settle on their own, so they do not keep a family open.
      hasUnsettled: members.some(
        (member) => !member.settled && !isCollapsibleRelation(member.relation),
      ),
    });
  }
  families.sort((left, right) => right.activityMs - left.activityMs);
  return { threads, children, families };
}

/** A child thread the canvas asked for and has not received yet. */
export interface PendingChild {
  /** Key of the placeholder card, `scopedThreadKey` of the parent's environment and this id. */
  readonly key: string;
  readonly placeholderId: ThreadId;
  readonly parentKey: string;
  /** Key of the created thread, once creation returned it. */
  readonly createdKey: string | null;
  readonly title: string;
  readonly startedAt: string;
}

/** A card that stands in for the new thread: the parent's place and settings, none of its state. */
function placeholderShell(
  parent: EnvironmentThreadShell,
  id: ThreadId,
  pending: PendingChild,
): EnvironmentThreadShell {
  return {
    ...parent,
    id,
    title: pending.title,
    lineage: { ...parent.lineage, parentThreadId: null, rootThreadId: id },
    forkedFrom: null,
    latestRun: null,
    runtime: null,
    goal: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: null,
    settledOverride: null,
    pinnedAt: null,
    createdAt: pending.startedAt,
    updatedAt: pending.startedAt,
    lastVisitedAt: pending.startedAt,
  };
}

/**
 * Adds a placeholder card under each parent for children still being created. One disappears
 * once its real thread is in the forest, which then takes its place.
 */
export function withPendingChildren(
  forest: CanvasForest,
  pending: ReadonlyArray<PendingChild>,
): CanvasForest {
  const shown = pending.filter(
    (entry) =>
      forest.threads.has(entry.parentKey) &&
      (entry.createdKey === null || !forest.threads.has(entry.createdKey)),
  );
  if (shown.length === 0) return forest;
  const threads = new Map(forest.threads);
  const children = new Map(forest.children);
  const added = new Map<string, CanvasThread[]>();
  for (const entry of shown) {
    const parent = forest.threads.get(entry.parentKey)!;
    const startedMs = millis(entry.startedAt);
    const item: CanvasThread = {
      key: entry.key,
      thread: placeholderShell(parent.thread, entry.placeholderId, entry),
      parentKey: parent.key,
      relation: "linked",
      engineRoot: true,
      settled: false,
      createdAtMs: startedMs,
      activityMs: startedMs,
      pending: true,
    };
    threads.set(item.key, item);
    children.set(parent.key, [...(children.get(parent.key) ?? []), item.key]);
    added.set(parent.key, [...(added.get(parent.key) ?? []), item]);
  }
  const families = forest.families.map((family) => {
    const extra = family.members.flatMap((member) => added.get(member.key) ?? []);
    if (extra.length === 0) return family;
    return {
      ...family,
      members: [...family.members, ...extra],
      activityMs: Math.max(family.activityMs, ...extra.map((item) => item.activityMs)),
      hasUnsettled: true,
    };
  });
  return { threads, children, families };
}

export function filterCanvasFamilies(
  families: ReadonlyArray<CanvasFamily>,
  input: { readonly includeSettled: boolean; readonly projectKey: string | null },
): ReadonlyArray<CanvasFamily> {
  return families.filter(
    (family) =>
      (input.includeSettled || family.hasUnsettled) &&
      (input.projectKey === null ||
        projectKeyOf(family.root.thread.environmentId, family.root.thread.projectId) ===
          input.projectKey),
  );
}

/** Threads doing the same work: one pull request, or one worktree branch of a project. */
export interface SameWork {
  readonly key: string;
  readonly kind: "pr" | "branch";
  readonly number: number | null;
  readonly title: string | null;
  readonly branch: string | null;
}

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

function sameWorkOf(thread: EnvironmentThreadShell): SameWork | null {
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests);
  const url = link?.url ?? thread.linkedPullRequest?.url ?? null;
  if (url !== null) {
    return {
      key: `pr|${url.toLowerCase()}`,
      kind: "pr",
      number: link?.number ?? thread.linkedPullRequest?.number ?? null,
      title: link?.snapshot?.title ?? null,
      branch: link?.snapshot?.headBranch ?? null,
    };
  }
  if (thread.branch === null || thread.worktreePath === null) return null;
  if (DEFAULT_BRANCHES.has(thread.branch)) return null;
  return {
    key: `branch|${thread.environmentId}|${thread.projectId}|${thread.branch}|${thread.worktreePath}`,
    kind: "branch",
    number: null,
    title: null,
    branch: thread.branch,
  };
}

/** Families that share work move next to the first of them, so the layout can outline them. */
function clusterSameWork(families: ReadonlyArray<CanvasFamily>): ReadonlyArray<CanvasFamily> {
  const workOf = new Map<string, ReadonlySet<string>>();
  const familiesOf = new Map<string, CanvasFamily[]>();
  for (const family of families) {
    const keys = new Set<string>();
    for (const member of family.members) {
      const work = sameWorkOf(member.thread);
      if (work !== null) keys.add(work.key);
    }
    workOf.set(family.key, keys);
    for (const key of keys) {
      const list = familiesOf.get(key);
      if (list === undefined) familiesOf.set(key, [family]);
      else list.push(family);
    }
  }
  const placed = new Set<string>();
  const ordered: CanvasFamily[] = [];
  for (const family of families) {
    if (placed.has(family.key)) continue;
    const queue = [family];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (placed.has(next.key)) continue;
      placed.add(next.key);
      ordered.push(next);
      for (const key of workOf.get(next.key) ?? []) {
        for (const other of familiesOf.get(key) ?? []) {
          if (!placed.has(other.key)) queue.push(other);
        }
      }
    }
  }
  return ordered;
}

// Node size matches the card's `w-72 h-28`.
const THREAD_NODE_WIDTH = 288;
const THREAD_NODE_HEIGHT = 112;
const FAMILY_GAP = 40;
const RANK_GAP = 128;
const SIBLING_GAP = 16;
const PROJECT_HEADER = 48;
const PROJECT_PADDING = 20;
const PROJECT_GAP = 32;
// Narrow screens (phones): trees become an indented outline, children below their parent.
const OUTLINE_INDENT = 24;
const OUTLINE_ROW_GAP = 12;
const OUTLINE_SOURCE_X = 16;
const OUTLINE_BREAKPOINT = THREAD_NODE_WIDTH * 2 + RANK_GAP;

// Declared so edges route before the first measure; the card's Handles sit at the same points.
const TREE_NODE_HANDLES: NodeHandle[] = [
  { type: "target", position: Position.Left, x: 0, y: THREAD_NODE_HEIGHT / 2, width: 1, height: 1 },
  {
    type: "source",
    position: Position.Right,
    x: THREAD_NODE_WIDTH - 1,
    y: THREAD_NODE_HEIGHT / 2,
    width: 1,
    height: 1,
  },
];
const OUTLINE_NODE_HANDLES: NodeHandle[] = [
  { type: "target", position: Position.Left, x: 0, y: THREAD_NODE_HEIGHT / 2, width: 1, height: 1 },
  {
    type: "source",
    position: Position.Bottom,
    x: OUTLINE_SOURCE_X,
    y: THREAD_NODE_HEIGHT - 1,
    width: 1,
    height: 1,
  },
];

/** Same-work threads the layout could not outline together: the card names them instead. */
export type SameWorkChip = {
  readonly kind: SameWork["kind"];
  readonly others: ReadonlyArray<{ readonly key: string; readonly title: string }>;
};

export type ThreadNodeData = {
  readonly item: CanvasThread;
  readonly familyKey: string;
  readonly sameWork?: SameWorkChip;
  readonly subagentCount: number;
  readonly subagentsExpanded: boolean;
  /** Indented outline (narrow screens): the source handle sits at the card's bottom left. */
  readonly outline: boolean;
  /** Set on roots where projects are mixed together. */
  readonly projectTitle?: string;
};
export type ProjectNodeData = {
  readonly projectKey: string;
  readonly title: string;
  readonly familyCount: number;
  readonly threadCount: number;
  readonly collapsed: boolean;
};
export type LineageEdgeData = {
  readonly relation: CanvasRelation;
  readonly childCreatedAt: string;
};
export type SameWorkNodeData = {
  readonly kind: SameWork["kind"];
  readonly number: number | null;
  readonly title: string | null;
  readonly branch: string | null;
};
export type ThreadFlowNode = Node<ThreadNodeData, "thread">;
export type ProjectFlowNode = Node<ProjectNodeData, "project">;
export type SameWorkFlowNode = Node<SameWorkNodeData, "sameWork">;
export type CanvasFlowNode = ThreadFlowNode | ProjectFlowNode | SameWorkFlowNode;
export type LineageFlowEdge = Edge<LineageEdgeData, "lineage">;

export interface CanvasLayout {
  readonly nodes: ReadonlyArray<CanvasFlowNode>;
  readonly edges: ReadonlyArray<LineageFlowEdge>;
}

export type SavedPositions = Readonly<Record<string, XYPosition>>;

export const savedPositionKey = (mode: CanvasMode, nodeId: string) => `${mode}|${nodeId}`;

interface PlacedFamily {
  readonly family: CanvasFamily;
  readonly width: number;
  readonly height: number;
  readonly positions: ReadonlyMap<string, XYPosition>;
  readonly visible: ReadonlyArray<CanvasThread>;
}

function placeFamily(
  family: CanvasFamily,
  expandedSubagents: ReadonlySet<string>,
  outline: boolean,
): PlacedFamily {
  const visibleKeys = new Set<string>();
  const visible: CanvasThread[] = [];
  for (const member of family.members) {
    const shown =
      member.parentKey === null ||
      (visibleKeys.has(member.parentKey) &&
        (!isCollapsibleRelation(member.relation) || expandedSubagents.has(member.parentKey)));
    if (!shown) continue;
    visibleKeys.add(member.key);
    visible.push(member);
  }
  if (visible.length === 1) {
    return {
      family,
      width: THREAD_NODE_WIDTH,
      height: THREAD_NODE_HEIGHT,
      positions: new Map([[family.root.key, { x: 0, y: 0 }]]),
      visible,
    };
  }
  if (outline) return placeFamilyOutline(family, visible);
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: SIBLING_GAP, ranksep: RANK_GAP });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const member of visible) {
    graph.setNode(member.key, { width: THREAD_NODE_WIDTH, height: THREAD_NODE_HEIGHT });
  }
  for (const member of visible) {
    if (member.parentKey !== null) graph.setEdge(member.parentKey, member.key);
  }
  dagre.layout(graph);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const raw = new Map<string, XYPosition>();
  for (const member of visible) {
    const placed = graph.node(member.key);
    const x = placed.x - THREAD_NODE_WIDTH / 2;
    const y = placed.y - THREAD_NODE_HEIGHT / 2;
    raw.set(member.key, { x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + THREAD_NODE_WIDTH);
    maxY = Math.max(maxY, y + THREAD_NODE_HEIGHT);
  }
  return {
    family,
    width: maxX - minX,
    height: maxY - minY,
    positions: new Map(
      [...raw].map(([key, position]) => [key, { x: position.x - minX, y: position.y - minY }]),
    ),
    visible,
  };
}

/** Depth-first, each child one indent right of its parent and below it. */
function placeFamilyOutline(
  family: CanvasFamily,
  visible: ReadonlyArray<CanvasThread>,
): PlacedFamily {
  const childrenOf = new Map<string, CanvasThread[]>();
  for (const member of visible) {
    if (member.parentKey === null) continue;
    const siblings = childrenOf.get(member.parentKey);
    if (siblings === undefined) childrenOf.set(member.parentKey, [member]);
    else siblings.push(member);
  }
  const positions = new Map<string, XYPosition>();
  const ordered: CanvasThread[] = [];
  let width = THREAD_NODE_WIDTH;
  const visit = (member: CanvasThread, depth: number) => {
    const x = depth * OUTLINE_INDENT;
    positions.set(member.key, { x, y: ordered.length * (THREAD_NODE_HEIGHT + OUTLINE_ROW_GAP) });
    width = Math.max(width, x + THREAD_NODE_WIDTH);
    ordered.push(member);
    for (const child of childrenOf.get(member.key) ?? []) visit(child, depth + 1);
  };
  visit(family.root, 0);
  return {
    family,
    width,
    height: ordered.length * (THREAD_NODE_HEIGHT + OUTLINE_ROW_GAP) - OUTLINE_ROW_GAP,
    positions,
    visible: ordered,
  };
}

/** Families left to right in reading order, wrapping into rows no wider than `maxWidth`. */
function packFamilies(placed: ReadonlyArray<PlacedFamily>, maxWidth: number) {
  const offsets = new Map<string, XYPosition>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const item of placed) {
    if (x > 0 && x + item.width > maxWidth) {
      x = 0;
      y += rowHeight + FAMILY_GAP;
      rowHeight = 0;
    }
    offsets.set(item.family.key, { x, y });
    width = Math.max(width, x + item.width);
    x += item.width + FAMILY_GAP;
    rowHeight = Math.max(rowHeight, item.height);
  }
  return { offsets, width, height: placed.length === 0 ? 0 : y + rowHeight };
}

const SAME_WORK_PAD = 10;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const rectOf = (node: CanvasFlowNode): Rect => ({
  x: node.position.x,
  y: node.position.y,
  width: node.width ?? THREAD_NODE_WIDTH,
  height: node.height ?? THREAD_NODE_HEIGHT,
});

const overlaps = (left: Rect, right: Rect) =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height;

/**
 * Same-work threads that sit together get one soft outline behind them. Where another card sits in
 * between, or they live in different project regions, each card names the others instead.
 */
function withSameWork(nodes: ReadonlyArray<CanvasFlowNode>): CanvasFlowNode[] {
  const threadNodes = nodes.filter((node): node is ThreadFlowNode => node.type === "thread");
  const groups = new Map<string, { work: SameWork; members: ThreadFlowNode[] }>();
  for (const node of threadNodes) {
    const work = sameWorkOf(node.data.item.thread);
    if (work === null) continue;
    const group = groups.get(work.key);
    if (group === undefined) groups.set(work.key, { work, members: [node] });
    else group.members.push(node);
  }
  const outlines: SameWorkFlowNode[] = [];
  const chips = new Map<string, SameWorkChip>();
  const outlineOf = (work: SameWork, members: ReadonlyArray<ThreadFlowNode>, id: string) => {
    const parentId = members[0]!.parentId;
    if (members.some((member) => member.parentId !== parentId)) return null;
    const rects = members.map(rectOf);
    const minX = Math.min(...rects.map((rect) => rect.x)) - SAME_WORK_PAD;
    const minY = Math.min(...rects.map((rect) => rect.y)) - SAME_WORK_PAD;
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width)) + SAME_WORK_PAD;
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height)) + SAME_WORK_PAD;
    const box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    const memberIds = new Set(members.map((member) => member.id));
    const blocked = threadNodes.some(
      (other) =>
        !memberIds.has(other.id) && other.parentId === parentId && overlaps(rectOf(other), box),
    );
    if (blocked) return null;
    const outlineNode: SameWorkFlowNode = {
      id,
      type: "sameWork",
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      measured: { width: box.width, height: box.height },
      ...(parentId === undefined ? {} : { parentId }),
      draggable: false,
      selectable: false,
      focusable: false,
      style: { pointerEvents: "none" },
      data: { kind: work.kind, number: work.number, title: work.title, branch: work.branch },
    };
    return outlineNode;
  };
  for (const { work, members } of groups.values()) {
    if (members.length < 2) continue;
    const whole = outlineOf(work, members, `same-work|${work.key}`);
    if (whole !== null) {
      outlines.push(whole);
      continue;
    }
    // Apart as a whole: outline each tree's share that sits together, name the rest on the card.
    const outlined = new Set<string>();
    for (const [familyKey, share] of groupBy(members, (member) => member.data.familyKey)) {
      if (share.length < 2) continue;
      const outlineNode = outlineOf(work, share, `same-work|${work.key}|${familyKey}`);
      if (outlineNode === null) continue;
      outlines.push(outlineNode);
      for (const member of share) outlined.add(member.id);
    }
    for (const member of members) {
      if (outlined.has(member.id)) continue;
      chips.set(member.id, {
        kind: work.kind,
        others: members
          .filter((other) => other !== member)
          .map((other) => ({ key: other.id, title: other.data.item.thread.title })),
      });
    }
  }
  const withChips = nodes.map((node): CanvasFlowNode => {
    const chip = node.type === "thread" ? chips.get(node.id) : undefined;
    return chip === undefined || node.type !== "thread"
      ? node
      : { ...node, data: { ...node.data, sameWork: chip } };
  });
  // Parents first, then the outlines, then the cards, so every outline sits behind its cards.
  return [
    ...withChips.filter((node) => node.type === "project"),
    ...outlines,
    ...withChips.filter((node) => node.type !== "project"),
  ];
}

export function layoutCanvas(input: {
  readonly forest: CanvasForest;
  readonly families: ReadonlyArray<CanvasFamily>;
  readonly mode: CanvasMode;
  readonly expandedSubagents: ReadonlySet<string>;
  readonly collapsedProjects: ReadonlySet<string>;
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly availableWidth: number;
  readonly savedPositions: SavedPositions;
}): CanvasLayout {
  const { forest, mode } = input;
  const maxWidth = Math.max(THREAD_NODE_WIDTH, input.availableWidth);
  const outline = input.availableWidth < OUTLINE_BREAKPOINT;
  const nodes: CanvasFlowNode[] = [];
  const edges: LineageFlowEdge[] = [];

  const emitFamily = (
    item: PlacedFamily,
    offset: XYPosition,
    parentId: string | undefined,
  ): string[] => {
    const ids: string[] = [];
    const shown = new Set(item.visible.map((member) => member.key));
    for (const member of item.visible) {
      const local = item.positions.get(member.key) ?? { x: 0, y: 0 };
      const childKeys = forest.children.get(member.key) ?? [];
      const subagentCount = childKeys.filter((key) =>
        isCollapsibleRelation(forest.threads.get(key)?.relation ?? null),
      ).length;
      nodes.push({
        id: member.key,
        type: "thread",
        position: input.savedPositions[savedPositionKey(mode, member.key)] ?? {
          x: offset.x + local.x,
          y: offset.y + local.y,
        },
        width: THREAD_NODE_WIDTH,
        height: THREAD_NODE_HEIGHT,
        measured: { width: THREAD_NODE_WIDTH, height: THREAD_NODE_HEIGHT },
        handles: outline ? OUTLINE_NODE_HANDLES : TREE_NODE_HANDLES,
        ...(parentId === undefined ? {} : { parentId, extent: "parent" as const }),
        data: {
          item: member,
          familyKey: item.family.key,
          subagentCount,
          subagentsExpanded: input.expandedSubagents.has(member.key),
          outline,
          // Roots where projects mix, and children a link brought in from another project.
          ...((mode === "tree" && member.parentKey === null) ||
          member.thread.projectId !== item.family.root.thread.projectId
            ? {
                projectTitle:
                  input.projectTitles.get(
                    projectKeyOf(member.thread.environmentId, member.thread.projectId),
                  ) ?? "",
              }
            : {}),
        },
      });
      ids.push(member.key);
      if (member.parentKey !== null && member.relation !== null && shown.has(member.parentKey)) {
        edges.push({
          id: `${member.parentKey}->${member.key}`,
          type: "lineage",
          source: member.parentKey,
          target: member.key,
          selectable: false,
          focusable: false,
          data: { relation: member.relation, childCreatedAt: member.thread.createdAt },
        });
      }
    }
    return ids;
  };

  const families = clusterSameWork(input.families);
  if (mode === "tree") {
    const placed = families.map((family) => placeFamily(family, input.expandedSubagents, outline));
    const packed = packFamilies(placed, maxWidth);
    for (const item of placed) {
      emitFamily(item, packed.offsets.get(item.family.key) ?? { x: 0, y: 0 }, undefined);
    }
    return { nodes: withSameWork(nodes), edges };
  }

  const byProject = groupBy(families, (family) =>
    projectKeyOf(family.root.thread.environmentId, family.root.thread.projectId),
  );
  const innerWidth = Math.max(THREAD_NODE_WIDTH, maxWidth - PROJECT_PADDING * 2);
  let y = 0;
  for (const [projectKey, families] of byProject) {
    const collapsed = input.collapsedProjects.has(projectKey);
    const placed = collapsed
      ? []
      : families.map((family) => placeFamily(family, input.expandedSubagents, outline));
    const packed = packFamilies(placed, innerWidth);
    const groupId = `project|${projectKey}`;
    const width = Math.max(packed.width, THREAD_NODE_WIDTH) + PROJECT_PADDING * 2;
    const height = collapsed ? PROJECT_HEADER : PROJECT_HEADER + packed.height + PROJECT_PADDING;
    nodes.push({
      id: groupId,
      type: "project",
      position: { x: 0, y },
      width,
      height,
      measured: { width, height },
      draggable: false,
      selectable: false,
      data: {
        projectKey,
        title: input.projectTitles.get(projectKey) ?? "",
        familyCount: families.length,
        threadCount: families.reduce((sum, family) => sum + family.members.length, 0),
        collapsed,
      },
    });
    for (const item of placed) {
      const offset = packed.offsets.get(item.family.key) ?? { x: 0, y: 0 };
      emitFamily(item, { x: PROJECT_PADDING + offset.x, y: PROJECT_HEADER + offset.y }, groupId);
    }
    y += height + PROJECT_GAP;
  }
  return { nodes: withSameWork(nodes), edges };
}

/** Threads `childKey` may be linked under: same environment, not itself or its descendants. */
export function linkCandidates(
  forest: CanvasForest,
  childKey: string,
): ReadonlyArray<CanvasThread> {
  const child = forest.threads.get(childKey);
  if (child === undefined) return [];
  const descendants = new Set<string>([childKey]);
  const queue = [childKey];
  while (queue.length > 0) {
    for (const key of forest.children.get(queue.shift()!) ?? []) {
      descendants.add(key);
      queue.push(key);
    }
  }
  return [...forest.threads.values()]
    .filter(
      (candidate) =>
        !descendants.has(candidate.key) &&
        candidate.thread.environmentId === child.thread.environmentId &&
        !isCollapsibleRelation(candidate.relation),
    )
    .sort((left, right) => right.activityMs - left.activityMs);
}

export function isDescendant(forest: CanvasForest, ancestorKey: string, key: string): boolean {
  const seen = new Set<string>();
  for (let at = forest.threads.get(key)?.parentKey ?? null; at !== null;) {
    if (at === ancestorKey) return true;
    if (seen.has(at)) return false;
    seen.add(at);
    at = forest.threads.get(at)?.parentKey ?? null;
  }
  return false;
}
