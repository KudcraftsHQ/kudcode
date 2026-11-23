# Updating Kud Code to a new nightly

`main` is an upstream T3 Code nightly tag plus the Kud commits. The tag it is built on is written in
`docs/kudcode/BASE`. An update replays the Kud commits onto a newer nightly, checks the result, builds the
Mac app, installs it and pushes `main`.

## The usual case

On the Mac, in a clean checkout of this repo:

```sh
node scripts/kud/update.ts --agent --build mac --install
```

(or `vp run kud:update -- --agent --build mac --install`). What it does:

1. Fetches upstream tags and `origin/main`, reads the base from `docs/kudcode/BASE` and picks the newest
   `v*-nightly.*` tag. `--to <tag>` picks one yourself; `--match-server <origin>` uses the version your T3
   server reports at `<origin>/.well-known/t3/environment`, so the client matches it.
2. Prints the `ORCHESTRATION_PROTOCOL_VERSION` of base and target and stops if they differ: a client on a
   different protocol cannot talk to the server. `--force` goes on anyway (also needed to go back to an
   older nightly).
3. Rebases the Kud commits onto the target on a new branch `kud/update-<tag>`. `main` is not touched yet.
4. Runs `vp i`, typechecks contracts, shared, client-runtime, web, desktop and scripts, and lints the Kud
   files.
5. Writes the new base to `docs/kudcode/BASE` and refreshes `docs/kudcode/PATCHES.md` in one
   `chore(kud): update to <tag>` commit (the previous one is dropped, so there is only ever one).
6. Builds the unsigned arm64 DMG (`vp run dist:desktop:dmg:arm64`), quits Kud Code, moves the old app to
   `/Applications/Kud Code (previous).app` and installs the new one as `/Applications/Kud Code.app`. It
   refuses to install a build that is not named Kud Code, and never touches `T3 Code*.app`.
7. Tags the old `main` as `kud-prev`, pushes the new `main` with `--force-with-lease` and tags it
   `kud-<upstream tag>`.

It ends with a summary: base and target, conflicts fixed and how, commits replayed, build path.

## When something conflicts

- **Generated files are never merged by hand.** `apps/web/src/routeTree.gen.ts` is regenerated with the
  TanStack router generator (also after a clean merge, as a check), `pnpm-lock.yaml` with `vp install`, and
  the i18n translation JSON is merged key by key: upstream's file plus the keys the Kud commit added or
  changed. (`vp run i18n:generate` is not run here: on a clean upstream tree it already rewrites about 160
  lines of upstream's own drift, which would land in Kud commits.)
- **Real conflicts with `--agent`** go to `claude -p` with the conflicting files, `DESIGN.md`,
  `PATCHES.md` and the rule "keep upstream's change and re-apply the Kud intent". It gets two tries per
  commit. Typecheck or lint errors go to the same fixer, at most three rounds; its fixes are committed as
  `fix(kud): build on <tag>`.
- **Without `--agent`, or when the agent gives up**, the script stops and prints each file, what
  `PATCHES.md` says about it, and the two commands that show the Kud intent and upstream's change. Fix the
  files (no `git add` needed), then:

```sh
node scripts/kud/update.ts --continue            # or --continue --agent
node scripts/kud/update.ts --abort               # back to where you started, update branch deleted
```

`git rerere` is on for the rebase, so a conflict you resolved once is resolved the same way next time.

## Rolling back

- **The app:** quit Kud Code, then
  `rm -rf "/Applications/Kud Code.app" && mv "/Applications/Kud Code (previous).app" "/Applications/Kud Code.app"`.
- **The code:** `git push --force-with-lease origin kud-prev:main`, then `git fetch && git reset --keep origin/main`.

## Checking for a new nightly every day

`node scripts/kud/check-nightly.ts` prints the new tag and exits 0 when upstream has a nightly newer than
`docs/kudcode/BASE` on `origin/main`, and exits 3 otherwise. It changes nothing. Run it daily on the Mac,
where the build happens, for example with a user LaunchAgent or cron:

```sh
cd ~/Projects/kudcode && node scripts/kud/check-nightly.ts --notify <ntfy-topic>
```

It always prints. `--notify <topic>` also runs `ntfy publish` when `ntfy` is on PATH (and is skipped
otherwise); `update.ts` takes the same flag for its result, and for a stop that needs you. To update
unattended, chain them: `node scripts/kud/check-nightly.ts && node scripts/kud/update.ts --agent --build mac --install --notify <topic>`.

## Other commands

- `node scripts/kud/patches.ts` rewrites `PATCHES.md`: every upstream file the Kud commits change, with
  line counts. Edit its Why column by hand; the rest is regenerated.
- `--main <branch> --no-push --no-fetch` runs the whole update against a local branch without pushing,
  which is how to rehearse it.
