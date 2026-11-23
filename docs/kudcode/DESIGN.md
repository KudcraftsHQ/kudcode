# Kud Code: design

Kud Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code) that adds a **node canvas of threads**
as the home screen, with **forking from an automatic short brief** instead of the parent's whole history.
It is a different *client*, not a different server: it runs next to the official T3 Code app and shows the
same threads, because it talks to the same T3 server.

## Principles

1. **Same server, same data.** Kud Code never runs its own server on `~/.t3`. It pairs with the server that
   official T3 Code (or `t3 service`) already runs, like any other client. Nothing Kud Code adds needs a
   server change.
2. **Small, rebasable diff.** Upstream nightly moves daily. Kud code lives in new files
   (`apps/web/src/kud/**`, `scripts/kud/**`, `docs/kudcode/**`); edits to upstream files are a few lines
   each and are listed in `docs/kudcode/PATCHES.md`. Generated files (`routeTree.gen.ts`, i18n output) are
   regenerated after a rebase, never hand-merged.
3. **Built on the engine's own lineage.** T3 already stores `lineage {parentThreadId, relationshipToParent:
   "fork"|"subagent", rootThreadId, sideChat?}` and `forkedFrom {type:"run", threadId, runId}` on every
   thread, and has `thread.fork`, `thread.merge_back` and `checkpoint.rollback`. The canvas draws these.
4. **Follows T3's conventions** (`AGENTS.md`, oxlint plugin `t3code/*`): React Compiler (no `useMemo` /
   `useCallback`), every `useEffect` carries an `oxlint-disable ... no-unreasoned-state-sync -- <reason>`,
   shadcn/base-ui components, theme tokens only (no raw colors), copy through i18n (`<T>`, `gt()`), no
   em dashes in copy, no continuously animated edges.

## 1. Canvas home (`apps/web/src/kud/canvas/`)

- Route `/canvas` (`apps/web/src/routes/_chat.canvas.tsx`, renders inside `SidebarInset` like
  `_chat.workflows.tsx`). `/` (`_chat.index.tsx` `IndexDraftLanding`) renders the canvas instead of
  auto-opening a draft. The sidebar stays visible for running threads and quick jumps.
- **React Flow** (`@xyflow/react`) + an automatic tree layout (`@dagrejs/dagre` or `elkjs`). Node types are
  declared at module scope. `colorMode` from `useTheme().resolvedTheme`; React Flow's `--xy-*` variables
  mapped to T3 theme tokens, so any T3 theme (built-in, VS Code import, published) restyles the canvas.
- Gestures: two-finger swipe pans, pinch zooms, drag on background pans, ctrl/cmd + wheel zooms; a plain
  wheel never zooms and double-click never zooms (`panOnScroll`, `panOnScrollMode: Free`,
  `zoomOnScroll: false`, `zoomOnPinch: true`, `zoomOnDoubleClick: false`, `panOnDrag: true`).
  Touch: one finger pans, pinch zooms, tap opens, long-press opens the actions menu (no hover on touch).
- **Modes** (search param `?mode=`, never a path segment):
  - `tree` (default): all projects, each thread family (shared `rootThreadId`) a tree, families ordered by
    latest activity.
  - `projects`: one labelled region per project (React Flow group node), families laid out inside it,
    collapsible.
  - Filters: unsettled only (default) / include settled, project scope, environment.
- **Node:** title, status (reuse `resolveThreadStatusPill` + `ThreadStatusIndicators`), provider/model,
  relative age, PR badge, fork/side-chat/subagent marker, and the first line of its brief (child threads) or
  latest visible message. Click opens the thread (`/$environmentId/$threadId`).
- **Edges:** parent from `forkedFrom.threadId` (fork from a run) else `lineage.parentThreadId`, the same rule
  as `client-runtime/state/threadRelationships.ts` `deriveThreadRelationshipGraph`. Fork edges are labelled
  with the fork point. Subagents are collapsed under their parent by default (count badge, expand on click).
  Manual links (below) are drawn like forks with a "linked" marker.
- **Data:** `useQuietThreadShells()` / `useProjects()` from `apps/web/src/state/entities.ts`. The shell
  stream drops settled threads past the newest 25 and idle subagents; for complete trees mount families
  with `threadFamilies.mount(...)` (`client-runtime/state/threadFamilies.ts`) for visible roots, and page
  older settled threads only when "include settled" is on. Never open a per-thread subscription per node;
  load detail only for the selected node.
- Node positions the user drags are remembered per viewer (localStorage, wrapped in try/catch).

## 2. Forking from a brief (`apps/web/src/kud/fork/`)

Briefs are automatic: no review step.

- **Fork here** (on an assistant message, next to upstream's "Fork from this response"; and on a canvas
  node, meaning "from its latest stable run"):
  1. `thread.fork` from run R (`threadEnvironment.forkFromRun`), title from the direction.
  2. In the child, a first message asks for a brief (<= ~250 words: goal, what is settled, open question,
     files and links that matter). It runs on the provider's native fork, so the parent's prompt cache
     makes it cheap.
  3. When that run completes, send the real first message with `freshContext: true`: the brief + the
     user's direction. From here the child carries a few hundred tokens of context instead of the parent's
     whole history. The brief turn stays visible in the child's timeline but never reaches the provider
     again.
  - Gate on `capabilities.freshContext` of the environment. Servers older than
    `0.1.11-nightly.20261119` reject `freshContext` while a fork is still being applied: on those, wait for
    the brief run to finish before the fresh send (always do this anyway), and if it is still rejected,
    fall back to a plain send and show a one-line notice.
- **Explore N directions:** one input with 2-4 directions (or "suggest directions", which asks the brief run
  to also propose 3). One brief run, then N forks from the same run R, each started with
  `freshContext: true` and the brief + its own direction. All start in parallel.
- **Report back:** `thread.merge_back` (`threadEnvironment.mergeBack`) from a child to its parent. Shown on
  a fork node and in the child's header.
- **Link to parent (manual):** drag a root node onto another node, or "Link under..." in the node menu.
  Stored as a thread tag `kud:parent:<threadId>` via `thread.tag.set` (shared by every client; official
  T3 Code does not display tags). Engine lineage always wins over the tag, so forks that inherit tags are
  unaffected. "Unlink" removes the tag.

## 3. Desktop app that coexists with T3 Code (`apps/desktop`, `scripts/build-desktop-artifact.ts`)

| Item | T3 Code | Kud Code |
|---|---|---|
| Bundle id | `com.t3tools.t3code` | `com.kudcrafts.kudcode` |
| Product name / .app | `T3 Code (Beta)` / `(Nightly)` | `Kud Code` |
| Electron userData (holds the single-instance lock) | `t3code-v2` | `kudcode-v2` |
| Desktop state dir | `~/.t3/userdata` | `~/.t3/kudcode` (base dir stays `~/.t3`) |
| OS URL scheme | `t3code://` (+ http/https viewer) | `kudcode://`, no http/https/html claims |
| Local backend | spawns its own server | **off by default** (`localEnvironmentEnabled=false`), pairs with the running server; host environment id read from `~/.t3/userdata/environment-id` |
| `t3` CLI shim | writes `~/.t3/bin/t3` | disabled |
| Managed policy file | `/Library/.../T3Code/policy.json` | `/Library/.../KudCode/policy.json` |
| Auto-update | GitHub feed | no feed (local builds), and hard-disabled |
| In-renderer scheme | `t3code://app` | unchanged (the server trusts this origin) |

Why: two desktop apps cannot both run a server on `~/.t3` (`server-owner.sqlite` lock: the second quits), and
a shared desktop state dir breaks the `safeStorage`-encrypted `connection-catalog.json` (each app's Keychain
key differs, each overwrites the other's). A paired client avoids both and shows the same data.

Theme: Kud Code starts on the same theme as T3 Code. If T3 Code keeps the selected theme in a file under
`~/.t3/userdata` (e.g. `client-settings.json`), Kud Code reads it read-only on start; installed custom
themes live in the renderer's localStorage and are imported once by the setup script.

## 4. Updating to a new nightly (`scripts/kud/`)

`main` on KudcraftsHQ/kudcode = an upstream nightly tag + the Kud commits. `scripts/kud/update.ts`:

1. Pick the target: the newest `v*-nightly.*` upstream tag, or `--to <tag>`, or `--match-server <url>` to
   use the version the user's T3 server reports (client and server should stay close; the client protocol
   `ORCHESTRATION_PROTOCOL_VERSION` must match exactly).
2. `git rebase --onto <target> <current-base> main` on a fresh branch `kud/update-<tag>`.
3. On conflict: stop and print the conflicting files with `docs/kudcode/PATCHES.md`, so an agent (or
   `--agent`, which runs `claude -p` with that context) resolves them. Generated files are regenerated
   (`routeTree.gen.ts`, i18n) rather than merged.
4. `vp i`, typecheck of `apps/web`, `apps/desktop`, `packages/client-runtime`.
5. Build the macOS app (`vp run dist:desktop:dmg:arm64` with the Kud identity) and install it to
   `/Applications/Kud Code.app` (on the Mac).
6. Fast-forward `main`, push, tag `kud-<upstream tag>`.

`docs/kudcode/UPDATING.md` is the runbook.
