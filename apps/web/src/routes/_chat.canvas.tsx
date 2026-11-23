import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { HomeCanvas, readCanvasSearch, type CanvasSearch } from "../kud/canvas/HomeCanvas";
import { KudManualLinksProvider } from "../kud/links/KudManualLinksProvider";

function CanvasRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <KudManualLinksProvider>
      <HomeCanvas
        search={search}
        onSearchChange={(next) => void navigate({ to: "/canvas", search: next, replace: true })}
      />
    </KudManualLinksProvider>
  );
}

export const Route = createFileRoute("/_chat/canvas")({
  validateSearch: (raw: Record<string, unknown>): CanvasSearch => readCanvasSearch(raw),
  component: CanvasRouteView,
});
