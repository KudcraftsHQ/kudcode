import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { createContext, use } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";

export type CanvasDialogKind = "fork" | "explore" | "link" | "child";

/** What a node can ask of the canvas around it. */
export interface CanvasInteractions {
  readonly openThread: (key: string) => void;
  readonly toggleSubagents: (key: string) => void;
  readonly toggleProject: (projectKey: string) => void;
  readonly openDialog: (kind: CanvasDialogKind, key: string) => void;
  readonly reportBack: (key: string) => void;
  readonly unlink: (key: string) => void;
  /** Selects these cards and brings them into view. */
  readonly highlight: (keys: ReadonlyArray<string>) => void;
  readonly providerFor: (thread: EnvironmentThreadShell) => ProviderInstanceEntry | null;
  /** Touch screens pan with one finger, so nodes there are not dragged. */
  readonly coarsePointer: boolean;
}

const noop = () => {};

export const CanvasInteractionsContext = createContext<CanvasInteractions>({
  openThread: noop,
  toggleSubagents: noop,
  toggleProject: noop,
  openDialog: noop,
  reportBack: noop,
  unlink: noop,
  highlight: noop,
  providerFor: () => null,
  coarsePointer: false,
});

export function useCanvasInteractions(): CanvasInteractions {
  return use(CanvasInteractionsContext);
}
