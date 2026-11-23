# Kud Code: upstream patches

Upstream files the Kud commits change, against `v0.1.12-nightly.20261123.5124`. Written by `node scripts/kud/patches.ts`,
which `scripts/kud/update.ts` runs after every update. Edit the Why column by hand; the rest is
rewritten. Files that only exist in Kud Code (`apps/web/src/kud/**`, `scripts/kud/**`,
`docs/kudcode/**`) are not listed.

| File                                                     | Why                                                            | Lines    |
| -------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| `apps/desktop/scripts/electron-launcher.mjs`             | feat(kud): Kud Code desktop identity that runs next to T3 Code | +26 -14  |
| `apps/desktop/src/app/DesktopAppIdentity.ts`             | feat(kud): Kud Code desktop identity that runs next to T3 Code | +4 -1    |
| `apps/desktop/src/app/DesktopClerk.ts`                   | feat(kud): Kud Code desktop identity that runs next to T3 Code | +6 -1    |
| `apps/desktop/src/app/DesktopCliCommand.ts`              | feat(kud): Kud Code desktop identity that runs next to T3 Code | +12 -0   |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`    | feat(kud): Kud Code desktop identity that runs next to T3 Code | +6 -1    |
| `apps/desktop/src/app/DesktopEnvironment.ts`             | feat(kud): Kud Code desktop identity that runs next to T3 Code | +21 -11  |
| `apps/desktop/src/app/DesktopLegacyLocalStorage.ts`      | feat(kud): Kud Code desktop identity that runs next to T3 Code | +19 -4   |
| `apps/desktop/src/app/DesktopLifecycle.ts`               | feat(kud): Kud Code desktop identity that runs next to T3 Code | +1 -1    |
| `apps/desktop/src/app/DesktopLinuxUrlHandler.ts`         | feat(kud): Kud Code desktop identity that runs next to T3 Code | +1 -1    |
| `apps/desktop/src/app/DesktopPreReadyPlatform.ts`        | feat(kud): Kud Code desktop identity that runs next to T3 Code | +1 -1    |
| `apps/desktop/src/app/DesktopStartupRecovery.ts`         | feat(kud): Kud Code desktop identity that runs next to T3 Code | +4 -1    |
| `apps/desktop/src/app/DesktopStatePaths.ts`              | feat(kud): Kud Code desktop identity that runs next to T3 Code | +19 -1   |
| `apps/desktop/src/app/DesktopUserData.ts`                | feat(kud): Kud Code desktop identity that runs next to T3 Code | +15 -4   |
| `apps/desktop/src/backend/DesktopBackendPool.ts`         | feat(kud): Kud Code desktop identity that runs next to T3 Code | +4 -1    |
| `apps/desktop/src/backend/DesktopHomeOwner.ts`           | feat(kud): Kud Code desktop identity that runs next to T3 Code | +4 -4    |
| `apps/desktop/src/electron/ElectronProtocol.ts`          | feat(kud): Kud Code desktop identity that runs next to T3 Code | +7 -0    |
| `apps/desktop/src/ipc/methods/localEnvironment.test.ts`  | feat(kud): Kud Code desktop identity that runs next to T3 Code | +1 -0    |
| `apps/desktop/src/ipc/methods/localEnvironment.ts`       | feat(kud): Kud Code desktop identity that runs next to T3 Code | +1 -1    |
| `apps/desktop/src/settings/DesktopAppSettings.ts`        | feat(kud): Kud Code desktop identity that runs next to T3 Code | +7 -2    |
| `apps/desktop/src/updates/DesktopUpdates.ts`             | feat(kud): Kud Code desktop identity that runs next to T3 Code | +3 -0    |
| `apps/desktop/vite.config.ts`                            | feat(kud): Kud Code desktop identity that runs next to T3 Code | +2 -0    |
| `apps/web/package.json`                                  | feat(kud): thread canvas home and fork with an automatic brief | +2 -0    |
| `apps/web/src/components/ThreadStatusIndicators.tsx`     | feat(kud): thread canvas home and fork with an automatic brief | +1 -1    |
| `apps/web/src/components/chat/TimelineAssistantRows.tsx` | feat(kud): thread canvas home and fork with an automatic brief | +5 -1    |
| `apps/web/src/components/settings/CodexSetupSection.tsx` | feat(kud): thread canvas home and fork with an automatic brief | +2 -1    |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`      | feat(kud): thread canvas home and fork with an automatic brief | +16 -1   |
| `apps/web/src/i18n/translations/de.json`                 | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/en.json`                 | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/es.json`                 | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/fr.json`                 | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/ja.json`                 | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/ko.json`                 | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/pt-BR.json`              | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/ru.json`                 | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/sv.json`                 | Generated; regenerated on every update, never hand-merged.     | +111 -20 |
| `apps/web/src/i18n/translations/zh.json`                 | Generated; regenerated on every update, never hand-merged.     | +110 -19 |
| `apps/web/src/routeTree.gen.ts`                          | Generated; regenerated on every update, never hand-merged.     | +21 -0   |
| `apps/web/src/routes/_chat.index.tsx`                    | feat(kud): thread canvas home and fork with an automatic brief | +3 -108  |
| `apps/web/vite.config.ts`                                | feat(kud): thread canvas home and fork with an automatic brief | +4 -1    |
| `knip.jsonc`                                             | feat(kud): Kud Code desktop identity that runs next to T3 Code | +8 -1    |
| `package.json`                                           | feat(kud): nightly update pipeline, design and runbook         | +4 -1    |
| `packages/shared/package.json`                           | feat(kud): Kud Code desktop identity that runs next to T3 Code | +4 -0    |
| `packages/shared/src/managedPolicyFile.ts`               | feat(kud): Kud Code desktop identity that runs next to T3 Code | +5 -5    |
| `packages/shared/src/promptLinks.ts`                     | feat(kud): Kud Code desktop identity that runs next to T3 Code | +6 -2    |
| `packages/shared/src/providerAuthReturnUrl.ts`           | feat(kud): Kud Code desktop identity that runs next to T3 Code | +3 -1    |
| `packages/shared/src/remote.ts`                          | feat(kud): Kud Code desktop identity that runs next to T3 Code | +2 -1    |
| `pnpm-lock.yaml`                                         | Generated; regenerated on every update, never hand-merged.     | +199 -0  |
| `scripts/build-desktop-artifact.ts`                      | feat(kud): Kud Code desktop identity that runs next to T3 Code | +66 -52  |
| `scripts/lib/brand-assets.ts`                            | feat(kud): Kud Code desktop identity that runs next to T3 Code | +20 -1   |

49 files, 2069 changed lines.
