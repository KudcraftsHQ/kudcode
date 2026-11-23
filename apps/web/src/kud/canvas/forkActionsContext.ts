import * as Schema from "effect/Schema";
import { createContext, use } from "react";

import { KUD_FORK_ACTIONS } from "../fork/useKudForkActions";
import type { KudForkActions } from "../shared/contract";

/** Thrown by the default actions, before the real provider wraps the canvas. */
export class KudForkActionsUnavailableError extends Schema.TaggedError<KudForkActionsUnavailableError>()(
  "KudForkActionsUnavailableError",
  {},
) {}

export const isKudForkActionsUnavailable = Schema.is(KudForkActionsUnavailableError);

/**
 * The fork actions the canvas calls: the real ones from `kud/fork`. A test or preview can wrap the
 * canvas in a provider with others.
 * @public
 */
export const KudForkActionsContext = createContext<KudForkActions>(KUD_FORK_ACTIONS);

export function useKudForkActions(): KudForkActions {
  return use(KudForkActionsContext);
}
