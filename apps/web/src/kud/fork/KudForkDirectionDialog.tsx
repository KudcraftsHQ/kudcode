import { T, useGT } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export type KudForkDirectionMode = "single" | "explore";

const MIN_DIRECTIONS = 2;
const MAX_DIRECTIONS = 4;

interface DirectionEntry {
  readonly key: number;
  readonly text: string;
}

let nextEntryKey = 0;
const newEntry = (): DirectionEntry => ({ key: nextEntryKey++, text: "" });

/**
 * Asks where a fork should go. `single` takes one direction; `explore` takes 2 to 4, one child
 * each. The dialog only collects text: the caller runs the fork and closes it.
 */
export function KudForkDirectionDialog({
  mode,
  open,
  busy,
  onOpenChange,
  onSubmit,
}: {
  readonly mode: KudForkDirectionMode;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (directions: ReadonlyArray<string>) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so each opening starts empty. */}
      {open ? <DirectionForm mode={mode} busy={busy} onSubmit={onSubmit} /> : null}
    </Dialog>
  );
}

function DirectionForm({
  mode,
  busy,
  onSubmit,
}: {
  readonly mode: KudForkDirectionMode;
  readonly busy: boolean;
  readonly onSubmit: (directions: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const id = useId();
  const [directions, setDirections] = useState<ReadonlyArray<DirectionEntry>>(() =>
    Array.from({ length: mode === "single" ? 1 : MIN_DIRECTIONS }, newEntry),
  );
  const filled = directions.map((entry) => entry.text.trim()).filter((text) => text.length > 0);
  const required = mode === "single" ? 1 : MIN_DIRECTIONS;
  const canSubmit = !busy && filled.length >= required;
  const setDirection = (key: number, text: string) =>
    setDirections((current) => current.map((entry) => (entry.key === key ? { key, text } : entry)));

  return (
    <DialogPopup className="sm:max-w-lg">
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onSubmit(filled);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "single" ? <T>Fork with brief</T> : <T>Explore directions</T>}
          </DialogTitle>
          <DialogDescription>
            {mode === "single" ? (
              <T>
                The fork starts from a short brief of this thread instead of its whole history, then
                takes the direction you give it.
              </T>
            ) : (
              <T>
                One brief of this thread, then one fork per direction, all started at once. Each
                carries the brief instead of the whole history.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {directions.map((entry, index) => (
              <div key={entry.key} className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`${id}-${index}`}>
                    {mode === "single"
                      ? gt("Direction")
                      : gt("Direction {number}", { number: index + 1 })}
                  </Label>
                  {mode === "explore" && directions.length > MIN_DIRECTIONS ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={gt("Remove this direction")}
                            onClick={() =>
                              setDirections((current) =>
                                current.filter((candidate) => candidate.key !== entry.key),
                              )
                            }
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        <T>Remove this direction</T>
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
                <Textarea
                  id={`${id}-${index}`}
                  value={entry.text}
                  autoFocus={index === 0}
                  placeholder={
                    mode === "single"
                      ? gt("What should the fork do next?")
                      : gt("One way to take this thread")
                  }
                  onChange={(event) => setDirection(entry.key, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      if (canSubmit) onSubmit(filled);
                    }
                  }}
                />
              </div>
            ))}
            {mode === "explore" && directions.length < MAX_DIRECTIONS ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setDirections((current) => [...current, newEntry()])}
              >
                <PlusIcon />
                <T>Add direction</T>
              </Button>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="submit" disabled={!canSubmit}>
            {mode === "single"
              ? gt("Fork", { $context: "button that starts a fork from a brief" })
              : gt("{count, plural, one {Start {count} fork} other {Start {count} forks}}", {
                  count: filled.length,
                })}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
