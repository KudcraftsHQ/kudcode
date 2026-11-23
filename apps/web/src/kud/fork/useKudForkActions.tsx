import { createContext, use } from "react";

import type { KudForkActions } from "../shared/contract";
import { exploreDirections, forkWithBrief, reportBack, setManualParent } from "./forkJobs";

// The work runs in module-level jobs (see forkJobs.ts), so the actions hold no React state and
// keep going after the component that started them unmounts.
export const KUD_FORK_ACTIONS: KudForkActions = {
  forkWithBrief,
  exploreDirections,
  reportBack,
  setManualParent,
};

const KudForkActionsContext = createContext<KudForkActions>(KUD_FORK_ACTIONS);

export function useKudForkActions(): KudForkActions {
  return use(KudForkActionsContext);
}
