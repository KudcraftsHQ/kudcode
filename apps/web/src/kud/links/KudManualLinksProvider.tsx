// Kud Code: serves the manual link store to the canvas through `KudManualLinksContext`.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShells, useQuietThreadShells, useServerConfigs } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import {
  type KudManualLink,
  type KudManualLinks,
  KudManualLinksContext,
  readKudParentTag,
} from "../shared/contract";
import {
  type EnvironmentLinkState,
  loadEnvironmentLinks,
  migrateParentTags,
  readLinkStore,
  subscribeLinkStore,
} from "./linkStore";

/** Links change rarely and only by hand; a slow refresh plus window focus is enough. */
const REFRESH_INTERVAL_MS = 3 * 60_000;

function refreshConnectedEnvironments() {
  for (const environmentId of appAtomRegistry.get(environmentServerConfigsAtom).keys()) {
    void loadEnvironmentLinks(environmentId);
  }
}

function hasEngineParent(thread: EnvironmentThreadShell): boolean {
  return thread.forkedFrom?.type === "run" || thread.lineage.parentThreadId !== null;
}

function buildLinks(
  environmentIds: ReadonlyArray<EnvironmentId>,
  store: ReadonlyMap<EnvironmentId, EnvironmentLinkState>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): KudManualLinks {
  const byChild = new Map<string, KudManualLink>();
  for (const environmentId of environmentIds) {
    for (const link of store.get(environmentId)?.document.links ?? []) {
      byChild.set(scopedThreadKey(scopeThreadRef(environmentId, link.childThreadId)), {
        environmentId,
        parentThreadId: link.parentThreadId,
        childThreadId: link.childThreadId,
        ...(link.label === undefined ? {} : { label: link.label }),
        createdAt: link.createdAt,
      });
    }
  }
  // Tags not moved into the store yet (or a store this connection cannot read) still count.
  for (const thread of threads) {
    if (hasEngineParent(thread)) continue;
    const parentThreadId = readKudParentTag(thread.source.tags);
    if (parentThreadId === null || parentThreadId === thread.id) continue;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (byChild.has(key)) continue;
    byChild.set(key, {
      environmentId: thread.environmentId,
      parentThreadId,
      childThreadId: thread.id,
      createdAt: "",
    });
  }
  const loaded = environmentIds.every((environmentId) => {
    const status = store.get(environmentId)?.status;
    return status !== undefined && status !== "loading";
  });
  return { byChild, loaded };
}

export function KudManualLinksProvider({ children }: { readonly children: ReactNode }) {
  const serverConfigs = useServerConfigs();
  const threads = useQuietThreadShells();
  const store = useSyncExternalStore(subscribeLinkStore, readLinkStore);
  const environmentIds = [...serverConfigs.keys()];
  const environmentsKey = environmentIds.join("\n");
  const taggedKey = threads
    .filter((thread) => readKudParentTag(thread.source.tags) !== null)
    .map((thread) => `${thread.environmentId}:${thread.id}`)
    .join("\n");
  const loadedKey = environmentIds
    .filter((environmentId) => store.get(environmentId)?.status === "loaded")
    .join("\n");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the link file from each server when it connects; the file lives on the server, outside React.
  useEffect(() => {
    if (environmentsKey === "") return;
    for (const environmentId of environmentsKey.split("\n")) {
      if (readLinkStore().get(environmentId as EnvironmentId) === undefined) {
        void loadEnvironmentLinks(environmentId as EnvironmentId);
      }
    }
  }, [environmentsKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window focus and a slow timer to pick up links other clients wrote to the server.
  useEffect(() => {
    const onFocus = () => refreshConnectedEnvironments();
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshConnectedEnvironments();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(refreshConnectedEnvironments, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves old `kud:parent:` thread tags into the server's link file once that file has loaded; both live on the server.
  useEffect(() => {
    if (taggedKey === "" || loadedKey === "") return;
    const shells = readThreadShells();
    for (const environmentId of loadedKey.split("\n")) {
      void migrateParentTags(environmentId as EnvironmentId, shells);
    }
  }, [taggedKey, loadedKey]);

  const links = buildLinks(environmentIds, store, threads);
  return <KudManualLinksContext.Provider value={links}>{children}</KudManualLinksContext.Provider>;
}
