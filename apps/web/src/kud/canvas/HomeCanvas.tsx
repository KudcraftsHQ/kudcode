import "@xyflow/react/dist/base.css";
import "./canvas.css";

import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  Background,
  BackgroundVariant,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag,
  type XYPosition,
} from "@xyflow/react";
import { T, useGT, useMessages } from "gt-react";
import { FolderTreeIcon, ListFilterIcon, NetworkIcon, ScanIcon } from "lucide-react";
import { use, useEffect, useEffectEvent, useRef, useState } from "react";

import { NoProjectsHero } from "../../components/NoProjectsHero";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { SidebarInset } from "../../components/ui/sidebar";
import { toastManager } from "../../components/ui/toast";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { observeResize } from "../../lib/observeResize";
import { readLocalApi } from "../../localApi";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  useAllEnvironmentShellsBootstrapped,
  useHiddenThreadKeys,
  useProjects,
  useQuietThreadShells,
} from "../../state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadFamilies } from "../../state/threads";
import { newThreadId } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { KudManualLinksContext } from "../shared/contract";
import {
  ChildThreadDialog,
  DirectionDialog,
  LinkUnderDialog,
  type ChildThreadDraft,
} from "./CanvasDialogs";
import {
  CanvasInteractionsContext,
  type CanvasDialogKind,
  type CanvasInteractions,
} from "./canvasContext";
import {
  buildCanvasForest,
  filterCanvasFamilies,
  isDescendant,
  layoutCanvas,
  linkCandidates,
  projectKeyOf,
  savedPositionKey,
  withPendingChildren,
  type CanvasFamily,
  type CanvasFlowNode,
  type CanvasMode,
  type CanvasThread,
  type PendingChild,
  type SavedPositions,
} from "./canvasGraph.logic";
import {
  readCanvasViewport,
  readLastOpenedThreadKey,
  readSavedPositions,
  rememberCanvasViewport,
  rememberOpenedThreadKey,
  writeSavedPositions,
} from "./canvasStorage";
import { isKudForkActionsUnavailable, useKudForkActions } from "./forkActionsContext";
import { LineageEdge } from "./LineageEdge";
import { ProjectNode } from "./ProjectNode";
import { SameWorkNode } from "./SameWorkNode";
import { isStartedByCandidate, useRequestStartedBy, useStartedByAnswers } from "./startedBy";
import { ThreadNode } from "./ThreadNode";

export interface CanvasSearch {
  readonly mode?: "projects";
  readonly settled?: true;
  /** `environmentId:projectId` */
  readonly project?: string;
}

export function readCanvasSearch(raw: Record<string, unknown>): CanvasSearch {
  return {
    ...(raw.mode === "projects" ? { mode: "projects" as const } : {}),
    ...(raw.settled === true || raw.settled === "true" || raw.settled === 1 || raw.settled === "1"
      ? { settled: true as const }
      : {}),
    ...(typeof raw.project === "string" && raw.project
      ? { project: raw.project.slice(0, 400) }
      : {}),
  };
}

function patchSearch(
  search: CanvasSearch,
  patch: {
    readonly mode?: CanvasMode;
    readonly settled?: boolean;
    readonly project?: string | null;
  },
): CanvasSearch {
  const mode = patch.mode ?? search.mode ?? "tree";
  const settled = patch.settled ?? search.settled === true;
  const project = patch.project === undefined ? search.project : (patch.project ?? undefined);
  return {
    ...(mode === "projects" ? { mode } : {}),
    ...(settled ? { settled: true as const } : {}),
    ...(project === undefined ? {} : { project }),
  };
}

const nodeTypes = {
  thread: ThreadNode,
  project: ProjectNode,
  sameWork: SameWorkNode,
} satisfies NodeTypes;
const edgeTypes = { lineage: LineageEdge } satisfies EdgeTypes;

// Family reads are one request each; the most recent trees are the ones worth completing.
const FAMILY_MOUNT_LIMIT = 60;
const SETTLED_VISIBLE_COUNT = 60;
const WIDTH_STEP = 120;
const gutterFor = (width: number) => (width < 640 ? 16 : 48);
const VIEW_TOP = 24;

function readCoarsePointer(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

function useProviderEntries() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providersByEnvironment = useEnvironmentProviders();
  return new Map<string, ProviderInstanceEntry>(
    environments.flatMap((environment) => {
      const derived = deriveProviderInstanceEntries(
        providersByEnvironment.get(environment.environmentId) ??
          (environment.environmentId === primaryEnvironmentId ? providers : []),
      );
      const entries = environment.serverConfig
        ? applyProviderInstanceSettings(derived, environment.serverConfig.settings, null)
        : derived;
      return entries.map(
        (entry) => [`${environment.environmentId}:${entry.instanceId}`, entry] as const,
      );
    }),
  );
}

/** Keeps every thread of the trees on screen loaded, including the idle subagents the shell drops. */
function useCanvasFamilyMounts(families: ReadonlyArray<CanvasFamily>) {
  const roots = new Set<string>();
  for (const family of families) {
    if (roots.size >= FAMILY_MOUNT_LIMIT) break;
    for (const member of family.members) {
      roots.add(JSON.stringify([member.thread.environmentId, member.thread.lineage.rootThreadId]));
    }
  }
  const rootsKey = [...roots].sort().join("\n");
  const mounted = useRef(new Map<string, () => void>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the families of the trees on screen into the thread family registry and releases the ones that left
  useEffect(() => {
    const wanted = new Set(rootsKey === "" ? [] : rootsKey.split("\n"));
    for (const [key, release] of mounted.current) {
      if (wanted.has(key)) continue;
      release();
      mounted.current.delete(key);
    }
    for (const key of wanted) {
      if (mounted.current.has(key)) continue;
      const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
      mounted.current.set(key, threadFamilies.mount(appAtomRegistry, environmentId, threadId));
    }
  }, [rootsKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases every mounted family when the canvas unmounts
  useEffect(() => {
    const current = mounted.current;
    return () => {
      for (const release of current.values()) release();
      current.clear();
    };
  }, []);
}

export function HomeCanvas({
  search,
  onSearchChange,
}: {
  readonly search: CanvasSearch;
  readonly onSearchChange: (next: CanvasSearch) => void;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <ReactFlowProvider>
          <CanvasView search={search} onSearchChange={onSearchChange} />
        </ReactFlowProvider>
      </div>
    </SidebarInset>
  );
}

/** `/`: the canvas once a project exists, the first-run hero before that. */
export function KudHomeLanding() {
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const navigate = useNavigate();
  if (projects.some((project) => project.archivedAt == null)) {
    return (
      <HomeCanvas
        search={{}}
        onSearchChange={(next) => void navigate({ to: "/canvas", search: next })}
      />
    );
  }
  // A pending environment cannot prove the workspace is empty.
  return bootstrapped ? <NoProjectsHero /> : null;
}

interface DialogState {
  readonly kind: CanvasDialogKind;
  readonly key: string;
  /** What the child dialog held when its creation failed, so nothing typed is lost. */
  readonly draft?: ChildThreadDraft;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function CanvasView({
  search,
  onSearchChange,
}: {
  readonly search: CanvasSearch;
  readonly onSearchChange: (next: CanvasSearch) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const actions = useKudForkActions();
  const reactFlow = useReactFlow();
  const mode: CanvasMode = search.mode ?? "tree";
  const includeSettled = search.settled === true;

  const threads = useQuietThreadShells();
  const hiddenKeys = useHiddenThreadKeys();
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const providerEntries = useProviderEntries();
  const { environments } = useEnvironments();

  const liveProjects = projects
    .filter((project) => project.archivedAt == null)
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const projectTitles = new Map(
    liveProjects.map((project) => [projectKeyOf(project.environmentId, project.id), project.title]),
  );
  const projectKey =
    search.project !== undefined && projectTitles.has(search.project) ? search.project : null;

  const manualLinks = use(KudManualLinksContext);
  const startedBy = useStartedByAnswers();
  const [pendingChildren, setPendingChildren] = useState<ReadonlyArray<PendingChild>>([]);
  const forest = withPendingChildren(
    buildCanvasForest({
      threads,
      hiddenKeys,
      manualLinks: manualLinks.byChild,
      startedBy,
    }),
    pendingChildren,
  );
  const families = filterCanvasFamilies(forest.families, { includeSettled, projectKey });
  useCanvasFamilyMounts(families);
  // Agent-launched roots of the trees on screen; children placed by hand are already settled.
  useRequestStartedBy(
    startedBy,
    families.flatMap((family) =>
      family.members
        .filter((member) => member.relation !== "linked" && isStartedByCandidate(member.thread))
        .map((member) => member.thread),
    ),
  );

  const scopeProject =
    projectKey === null
      ? null
      : liveProjects.find(
          (project) => projectKeyOf(project.environmentId, project.id) === projectKey,
        );
  const shelf = useOlderSettledShelf({
    scopes:
      scopeProject != null
        ? [{ environmentId: scopeProject.environmentId, projectIds: [scopeProject.id] }]
        : [...new Set(liveProjects.map((project) => project.environmentId))].map(
            (environmentId) => ({ environmentId, projectIds: null }),
          ),
    expanded: includeSettled,
    visibleCount: SETTLED_VISIBLE_COUNT,
  });
  useOlderSettledShelfGrowth(
    shelf,
    threads.filter(
      (thread) =>
        thread.settledOverride === "settled" &&
        isListedThreadLineage(thread.lineage) &&
        (scopeProject == null ||
          (thread.environmentId === scopeProject.environmentId &&
            thread.projectId === scopeProject.id)) &&
        shelf.isListed(thread),
    ),
  );

  const [coarsePointer] = useState(readCoarsePointer);
  const [savedPositions, setSavedPositions] = useState<SavedPositions>(readSavedPositions);
  const [expandedSubagents, setExpandedSubagents] = useState<ReadonlySet<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** A new card to bring into view with its parent, once it is laid out. */
  const [focus, setFocus] = useState<{ key: string; parentKey: string } | null>(null);
  const [overrides, setOverrides] = useState<{
    readonly dragging: ReadonlyMap<string, XYPosition>;
    readonly selected: ReadonlySet<string>;
  }>(() => {
    const last = readLastOpenedThreadKey();
    return { dragging: new Map(), selected: new Set(last === null ? [] : [last]) };
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the canvas element so families wrap into rows that fit it
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    return observeResize(element, (entries) => {
      const measured = entries.at(-1)?.contentRect.width ?? 0;
      setWidth(Math.round(measured));
    });
  }, []);

  const layout = layoutCanvas({
    forest,
    families,
    mode,
    expandedSubagents,
    collapsedProjects,
    projectTitles,
    // Stepped, so a resize by a few pixels does not move every tree.
    availableWidth:
      Math.floor((width - gutterFor(width) * 2) / WIDTH_STEP) * WIDTH_STEP || WIDTH_STEP,
    savedPositions,
  });
  const nodes = layout.nodes.map((node): CanvasFlowNode => {
    const dragged = overrides.dragging.get(node.id);
    const selected = overrides.selected.has(node.id);
    if (dragged === undefined && !selected) return node;
    return { ...node, selected, ...(dragged === undefined ? {} : { position: dragged }) };
  });

  const focusLaidOut = focus !== null && nodes.some((node) => node.id === focus.key);
  // Runs once per new card: the placeholder it waits for leaves when the real thread arrives.
  // Reads the latest canvas width without re-scrolling on every resize.
  const scrollToFocus = useEffectEvent((parentKey: string, key: string) => {
    // At the current zoom: a queued fitView would wait for every card to be measured.
    const bounds = reactFlow.getNodesBounds([parentKey, key]);
    const zoom = reactFlow.getZoom();
    const gutter = gutterFor(width);
    if (bounds.width * zoom + gutter * 2 <= width) {
      void reactFlow.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
        zoom,
        duration: 250,
      });
      return;
    }
    // Too wide to centre (phones): line the parent up with the left gutter instead of cutting it off.
    void reactFlow.setCenter(bounds.x + (width / 2 - gutter) / zoom, bounds.y + bounds.height / 2, {
      zoom,
      duration: 250,
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls React Flow's viewport to a new card once it is on the canvas
  useEffect(() => {
    if (!focusLaidOut || focus === null) return;
    scrollToFocus(focus.parentKey, focus.key);
  }, [focusLaidOut, focus]);

  const refOf = (item: CanvasThread) => scopeThreadRef(item.thread.environmentId, item.thread.id);
  const errorDescription = (error: unknown) =>
    isKudForkActionsUnavailable(error)
      ? gt("Fork actions are not available yet.")
      : (thrownErrorMessage(error, m) ?? gt("An error occurred."));
  const showError = (title: string, error: unknown) =>
    toastManager.add({ type: "error", title, description: errorDescription(error) });
  const select = (key: string) =>
    setOverrides((current) => ({ ...current, selected: new Set([key]) }));

  const setParent = async (child: CanvasThread, parent: CanvasThread | null) => {
    try {
      await actions.setManualParent(refOf(child), parent === null ? null : refOf(parent));
      toastManager.add({
        type: "success",
        title:
          parent === null
            ? gt("Unlinked “{title}”", { title: child.thread.title })
            : gt("Linked under “{title}”", { title: parent.thread.title }),
      });
      return true;
    } catch (error) {
      showError(parent === null ? gt("Couldn’t unlink") : gt("Couldn’t link"), error);
      return false;
    }
  };

  const openRef = (ref: ScopedThreadRef) => {
    rememberOpenedThreadKey(scopedThreadKey(ref));
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };

  const createChild = (parent: CanvasThread, draft: ChildThreadDraft, open: boolean) => {
    const placeholderId = newThreadId();
    const key = scopedThreadKey(scopeThreadRef(parent.thread.environmentId, placeholderId));
    const message = draft.message.trim();
    setPendingChildren((current) => [
      ...current,
      {
        key,
        placeholderId,
        parentKey: parent.key,
        createdKey: null,
        title: firstLine(message) || gt("New thread"),
        startedAt: new Date().toISOString(),
      },
    ]);
    setDialog(null);
    select(key);
    setFocus({ key, parentKey: parent.key });
    actions.createChildThread({ parent: refOf(parent), message, withBrief: draft.withBrief }).then(
      (child) => {
        const childKey = scopedThreadKey(child);
        setPendingChildren((current) =>
          current.map((entry) => (entry.key === key ? { ...entry, createdKey: childKey } : entry)),
        );
        setOverrides((current) =>
          current.selected.has(key) ? { ...current, selected: new Set([childKey]) } : current,
        );
        if (open) openRef(child);
      },
      (error: unknown) => {
        setPendingChildren((current) => current.filter((entry) => entry.key !== key));
        showError(gt("Couldn’t create the thread"), error);
        setDialog({ kind: "child", key: parent.key, draft });
      },
    );
  };

  const interactions: CanvasInteractions = {
    openThread: (key) => {
      const item = forest.threads.get(key);
      if (item === undefined || item.pending) return;
      openRef(refOf(item));
    },
    toggleSubagents: (key) => setExpandedSubagents((current) => toggled(current, key)),
    toggleProject: (key) => setCollapsedProjects((current) => toggled(current, key)),
    openDialog: (kind, key) => setDialog({ kind, key }),
    reportBack: (key) => {
      const item = forest.threads.get(key);
      if (item === undefined) return;
      void actions.reportBack(refOf(item)).then(
        () => toastManager.add({ type: "success", title: gt("Reported back to the parent") }),
        (error: unknown) => showError(gt("Couldn’t report back"), error),
      );
    },
    unlink: (key) => {
      const item = forest.threads.get(key);
      if (item !== undefined) void setParent(item, null);
    },
    highlight: (keys) => {
      setOverrides((current) => ({ ...current, selected: new Set(keys) }));
      void reactFlow.fitView({
        nodes: keys.map((id) => ({ id })),
        padding: 0.2,
        maxZoom: 1,
        duration: 250,
      });
    },
    providerFor: (thread: EnvironmentThreadShell) =>
      providerEntries.get(
        `${thread.environmentId}:${thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId}`,
      ) ?? null,
    coarsePointer,
  };

  const onNodesChange = (changes: NodeChange<CanvasFlowNode>[]) =>
    setOverrides((current) => {
      let dragging = current.dragging;
      let selected = current.selected;
      for (const change of changes) {
        if (change.type === "position" && change.position !== undefined) {
          dragging = new Map(dragging).set(change.id, change.position);
        } else if (change.type === "select") {
          const next = new Set(selected);
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
          selected = next;
        }
      }
      return dragging === current.dragging && selected === current.selected
        ? current
        : { dragging, selected };
    });

  const settleDrag = (dropped: ReadonlyArray<CanvasFlowNode>, save: boolean) => {
    if (save) {
      setSavedPositions((current) => {
        const next: Record<string, XYPosition> = { ...current };
        for (const entry of dropped) next[savedPositionKey(mode, entry.id)] = entry.position;
        writeSavedPositions(next);
        return next;
      });
    }
    setOverrides((current) => {
      const dragging = new Map(current.dragging);
      for (const entry of dropped) dragging.delete(entry.id);
      return { ...current, dragging };
    });
  };

  const onNodeDragStop: OnNodeDrag<CanvasFlowNode> = (_event, node, dragged) => {
    const child = node.type === "thread" ? forest.threads.get(node.id) : undefined;
    const target =
      child === undefined || !child.engineRoot || dragged.length !== 1
        ? undefined
        : reactFlow
            .getIntersectingNodes(node)
            .map((entry) => (entry.type === "thread" ? forest.threads.get(entry.id) : undefined))
            .find(
              (entry): entry is CanvasThread =>
                entry !== undefined &&
                entry.key !== child.key &&
                entry.thread.environmentId === child.thread.environmentId &&
                !isDescendant(forest, child.key, entry.key),
            );
    if (child === undefined || target === undefined) {
      settleDrag(dragged, true);
      return;
    }
    const question = gt("Link “{child}” under “{parent}”?", {
      child: child.thread.title,
      parent: target.thread.title,
    });
    void (async () => {
      let confirmed = false;
      try {
        confirmed = (await readLocalApi()?.dialogs.confirm(question)) === true;
      } catch {
        confirmed = false;
      }
      settleDrag(dragged, false);
      if (confirmed) await setParent(child, target);
    })();
  };

  const resetLayout = () => {
    writeSavedPositions({});
    setSavedPositions({});
  };
  // First visit frames the newest trees from the top, at full size when they fit across.
  const contentWidth = Math.max(
    1,
    ...layout.nodes
      .filter((node) => node.parentId === undefined)
      .map((node) => node.position.x + (node.width ?? 0)),
  );
  // Phones keep full size and pan to the wider trees; shrinking them makes every card unreadable.
  const firstZoom =
    width < 640 ? 1 : Math.min(1, Math.max(0.5, (width - gutterFor(width) * 2) / contentWidth));
  const viewport = readCanvasViewport(mode) ?? {
    x: Math.max(gutterFor(width), (width - contentWidth * firstZoom) / 2),
    y: VIEW_TOP,
    zoom: firstZoom,
  };
  const dialogItem = dialog === null ? undefined : forest.threads.get(dialog.key);
  const filtersActive = includeSettled || projectKey !== null;
  const projectTitleOf = (item: CanvasThread) =>
    projectTitles.get(projectKeyOf(item.thread.environmentId, item.thread.projectId)) ?? "";
  const whereOf = (item: CanvasThread) => {
    const provider = interactions.providerFor(item.thread);
    const slug = item.thread.modelSelection.model;
    const model = provider?.models.find((entry) => entry.slug === slug);
    return gt("{project} on {machine}, {model}", {
      project: projectTitleOf(item),
      machine:
        environments.find((environment) => environment.environmentId === item.thread.environmentId)
          ?.label ?? item.thread.environmentId,
      model: model?.shortName ?? model?.name ?? slug,
    });
  };

  return (
    <CanvasInteractionsContext value={interactions}>
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <WorkspaceBreadcrumb ariaLabel={gt("Canvas breadcrumb")} className="min-w-0 flex-1">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">
              <T>Canvas</T>
            </h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="flex shrink-0 items-center gap-1.5">
          <ToggleGroup
            aria-label={gt("Canvas layout")}
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "tree" || value === "projects") {
                onSearchChange(patchSearch(search, { mode: value }));
              }
            }}
          >
            <Toggle value="tree" aria-label={gt("Trees")}>
              <NetworkIcon />
              <span className="hidden sm:inline">
                <T>Trees</T>
              </span>
            </Toggle>
            <Toggle value="projects" aria-label={gt("Projects")}>
              <FolderTreeIcon />
              <span className="hidden sm:inline">
                <T>Projects</T>
              </span>
            </Toggle>
          </ToggleGroup>
          <Menu>
            <MenuTrigger
              render={<Button variant={filtersActive ? "secondary" : "ghost-muted"} size="sm" />}
              aria-label={gt("Canvas filters")}
            >
              <ListFilterIcon />
              <span className="hidden sm:inline">
                <T>Filter</T>
              </span>
            </MenuTrigger>
            <MenuPopup align="end" className="max-h-96">
              <MenuCheckboxItem
                checked={includeSettled}
                onCheckedChange={(checked) =>
                  onSearchChange(patchSearch(search, { settled: checked }))
                }
              >
                <T>Include settled threads</T>
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>
                  <T>Project</T>
                </MenuGroupLabel>
                <MenuRadioGroup
                  value={projectKey ?? "all"}
                  onValueChange={(value) =>
                    onSearchChange(
                      patchSearch(search, {
                        project: value === "all" || typeof value !== "string" ? null : value,
                      }),
                    )
                  }
                >
                  <MenuRadioItem value="all">
                    <T>All projects</T>
                  </MenuRadioItem>
                  {liveProjects.map((project) => {
                    const key = projectKeyOf(project.environmentId, project.id);
                    return (
                      <MenuRadioItem key={key} value={key}>
                        <span className="truncate">{project.title}</span>
                      </MenuRadioItem>
                    );
                  })}
                </MenuRadioGroup>
              </MenuGroup>
              <MenuSeparator />
              <MenuItem disabled={Object.keys(savedPositions).length === 0} onClick={resetLayout}>
                <T>Reset node positions</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  aria-label={gt("Fit to screen")}
                  onClick={() => void reactFlow.fitView({ padding: 0.12, maxZoom: 1 })}
                />
              }
            >
              <ScanIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Fit to screen</T>
            </TooltipPopup>
          </Tooltip>
        </div>
      </WorkspacePageHeader>
      <div ref={containerRef} data-kud-canvas="" className="relative min-h-0 flex-1">
        {bootstrapped && width > 0 && families.length > 0 ? (
          <ReactFlow<CanvasFlowNode>
            key={mode}
            nodes={nodes}
            edges={[...layout.edges]}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={resolvedTheme}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onMoveEnd={(_event, viewport) => rememberCanvasViewport(mode, viewport)}
            defaultViewport={viewport}
            minZoom={0.2}
            maxZoom={1.75}
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            panOnDrag
            nodesDraggable={!coarsePointer}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            nodeDragThreshold={4}
            selectNodesOnDrag={false}
            deleteKeyCode={null}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          </ReactFlow>
        ) : bootstrapped && width > 0 ? (
          <Empty className="h-full">
            <EmptyHeader className="max-w-sm">
              <EmptyTitle>
                <T>No open threads</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Threads you start show up here as trees, with their forks branching off.</T>
              </EmptyDescription>
              {includeSettled ? null : (
                <div className="mt-5 flex justify-center">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onSearchChange(patchSearch(search, { settled: true }))}
                  >
                    <T>Include settled threads</T>
                  </Button>
                </div>
              )}
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
      {dialog?.kind === "child" && dialogItem !== undefined ? (
        <ChildThreadDialog
          parentTitle={dialogItem.thread.title}
          where={whereOf(dialogItem)}
          initial={dialog.draft}
          onClose={() => setDialog(null)}
          onSubmit={(draft, open) => createChild(dialogItem, draft, open)}
        />
      ) : null}
      {(dialog?.kind === "fork" || dialog?.kind === "explore") && dialogItem !== undefined ? (
        <DirectionDialog
          multiple={dialog.kind === "explore"}
          parentTitle={dialogItem.thread.title}
          onClose={() => setDialog(null)}
          onSubmit={async (directions) => {
            try {
              if (dialog.kind === "explore") {
                const started = await actions.exploreDirections({
                  thread: refOf(dialogItem),
                  directions,
                });
                toastManager.add({
                  type: "success",
                  title: gt("{count, plural, one {Started # fork} other {Started # forks}}", {
                    count: started.length,
                  }),
                });
              } else {
                const started = await actions.forkWithBrief({
                  thread: refOf(dialogItem),
                  direction: directions[0] ?? "",
                });
                select(scopedThreadKey(started));
                toastManager.add({ type: "success", title: gt("Fork started") });
              }
              return true;
            } catch (error) {
              showError(gt("Couldn’t start the fork"), error);
              return false;
            }
          }}
        />
      ) : null}
      {dialog?.kind === "link" && dialogItem !== undefined ? (
        <LinkUnderDialog
          childTitle={dialogItem.thread.title}
          candidates={linkCandidates(forest, dialogItem.key)}
          projectTitleOf={projectTitleOf}
          onClose={() => setDialog(null)}
          onPick={(parent) => setParent(dialogItem, parent)}
        />
      ) : null}
    </CanvasInteractionsContext>
  );
}
