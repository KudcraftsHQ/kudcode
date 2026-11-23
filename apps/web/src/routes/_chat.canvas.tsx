import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { HomeCanvas, readCanvasSearch, type CanvasSearch } from "../kud/canvas/HomeCanvas";

function CanvasRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <HomeCanvas
      search={search}
      onSearchChange={(next) => void navigate({ to: "/canvas", search: next, replace: true })}
    />
  );
}

export const Route = createFileRoute("/_chat/canvas")({
  validateSearch: (raw: Record<string, unknown>): CanvasSearch => readCanvasSearch(raw),
  component: CanvasRouteView,
});
