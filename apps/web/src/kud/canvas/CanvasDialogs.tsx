import { T, useGT } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import type { CanvasThread } from "./canvasGraph.logic";

const MIN_DIRECTIONS = 2;
const MAX_DIRECTIONS = 4;
const LINK_RESULTS_LIMIT = 50;

export interface ChildThreadDraft {
  readonly message: string;
  readonly withBrief: boolean;
}

/** A fresh thread under a card, or a fork from its brief when the switch is on. */
export function ChildThreadDialog({
  parentTitle,
  where,
  initial,
  onSubmit,
  onClose,
}: {
  readonly parentTitle: string;
  /** Project, machine and model, inherited from the parent. */
  readonly where: string;
  readonly initial: ChildThreadDraft | undefined;
  readonly onSubmit: (draft: ChildThreadDraft, open: boolean) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const id = useId();
  const [message, setMessage] = useState(initial?.message ?? "");
  const [withBrief, setWithBrief] = useState(initial?.withBrief ?? false);
  // A brief needs a direction; a plain thread without a message starts idle.
  const ready = !withBrief || message.trim() !== "";
  const submit = (open: boolean) => {
    if (ready) onSubmit({ message, withBrief }, open);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>New child thread</T>
            </DialogTitle>
            <DialogDescription>
              {gt("A fresh thread under “{title}”.", { title: parentTitle })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Textarea
                aria-label={gt("First message")}
                rows={4}
                autoFocus
                placeholder={
                  withBrief
                    ? gt("What should the new thread do next?")
                    : gt("What should the new thread do? Leave it empty to start it idle.")
                }
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="flex items-center gap-2">
                <Switch id={`${id}-brief`} checked={withBrief} onCheckedChange={setWithBrief} />
                <Label htmlFor={`${id}-brief`}>
                  <T>Start from a brief of this thread</T>
                </Label>
              </div>
              <p className="truncate text-muted-foreground text-xs">{where}</p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={!ready} onClick={() => submit(true)}>
              <T>Create and open</T>
            </Button>
            <Button type="submit" disabled={!ready}>
              <T>Create</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** One direction for "Fork with brief", or 2 to 4 for "Explore directions". */
export function DirectionDialog({
  multiple,
  parentTitle,
  onSubmit,
  onClose,
}: {
  readonly multiple: boolean;
  readonly parentTitle: string;
  readonly onSubmit: (directions: ReadonlyArray<string>) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const id = useId();
  const [directions, setDirections] = useState<ReadonlyArray<{ id: number; text: string }>>(() =>
    (multiple ? [0, 1] : [0]).map((rowId) => ({ id: rowId, text: "" })),
  );
  const [pending, setPending] = useState(false);
  const filled = directions.map((row) => row.text.trim()).filter((value) => value !== "");
  const ready = multiple ? filled.length >= MIN_DIRECTIONS : filled.length === 1;
  const setDirection = (rowId: number, text: string) =>
    setDirections((current) => current.map((row) => (row.id === rowId ? { ...row, text } : row)));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || pending) return;
            setPending(true);
            void onSubmit(filled).then((done) => {
              setPending(false);
              if (done) onClose();
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {multiple ? <T>Explore directions</T> : <T>Fork with brief</T>}
            </DialogTitle>
            <DialogDescription>
              {multiple
                ? gt("One brief of “{title}”, then one fork per direction, all started together.", {
                    title: parentTitle,
                  })
                : gt("A fork of “{title}” that starts from a short brief and your direction.", {
                    title: parentTitle,
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              {directions.map((row, index) => (
                <div key={row.id} className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-${row.id}`}>
                    {multiple ? gt("Direction {number}", { number: index + 1 }) : <T>Direction</T>}
                  </Label>
                  <div className="flex items-start gap-2">
                    <Textarea
                      id={`${id}-${row.id}`}
                      className="flex-1"
                      rows={multiple ? 2 : 4}
                      autoFocus={index === 0}
                      placeholder={
                        multiple
                          ? gt("What should this fork try?")
                          : gt("What should the fork do next?")
                      }
                      value={row.text}
                      disabled={pending}
                      onChange={(event) => setDirection(row.id, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    {multiple && directions.length > MIN_DIRECTIONS ? (
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label={gt("Remove direction {number}", { number: index + 1 })}
                        disabled={pending}
                        onClick={() =>
                          setDirections((current) => current.filter((entry) => entry.id !== row.id))
                        }
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
              {multiple && directions.length < MAX_DIRECTIONS ? (
                <div>
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      setDirections((current) => [
                        ...current,
                        { id: Math.max(...current.map((entry) => entry.id)) + 1, text: "" },
                      ])
                    }
                  >
                    <PlusIcon />
                    <T>Add direction</T>
                  </Button>
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={!ready || pending}>
              {multiple ? (
                gt("{count, plural, one {Start # fork} other {Start # forks}}", {
                  count: Math.max(filled.length, MIN_DIRECTIONS),
                })
              ) : (
                <T>Start fork</T>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Picks the thread to link a root under, for touch screens and anyone not dragging. */
export function LinkUnderDialog({
  childTitle,
  candidates,
  projectTitleOf,
  onPick,
  onClose,
}: {
  readonly childTitle: string;
  readonly candidates: ReadonlyArray<CanvasThread>;
  readonly projectTitleOf: (item: CanvasThread) => string;
  readonly onPick: (item: CanvasThread) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const needle = query.trim().toLocaleLowerCase();
  const matches = candidates
    .filter(
      (item) =>
        needle === "" ||
        item.thread.title.toLocaleLowerCase().includes(needle) ||
        projectTitleOf(item).toLocaleLowerCase().includes(needle),
    )
    .slice(0, LINK_RESULTS_LIMIT);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Link under…</T>
          </DialogTitle>
          <DialogDescription>
            {gt("Show “{title}” as a child of the thread you pick.", { title: childTitle })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              aria-label={gt("Search threads")}
              placeholder={gt("Search threads")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
              {matches.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    disabled={pending}
                    className="flex w-full min-w-0 flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden disabled:opacity-60"
                    onClick={() => {
                      setPending(true);
                      void onPick(item).then((done) => {
                        setPending(false);
                        if (done) onClose();
                      });
                    }}
                  >
                    <span className="w-full truncate text-foreground text-sm">
                      {item.thread.title}
                    </span>
                    <span className="w-full truncate text-muted-foreground text-xs">
                      {projectTitleOf(item)}
                    </span>
                  </button>
                </li>
              ))}
              {matches.length === 0 ? (
                <li className="px-2 py-6 text-center text-muted-foreground text-sm">
                  <T>No threads match.</T>
                </li>
              ) : null}
            </ul>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            <T>Cancel</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
