import { Icon } from "@/components/icon";
import type { ProjectVisibility } from "@/features/docs/types";

// project-visibility-fe S-001 / AS-001 / C-001. A small Private/Public pill on the project card,
// beside the existing Default badge — read STRAIGHT from the list row's `visibility`, never derived
// in the FE. Matches the Default-badge treatment (rounded-full, line border, muted text); the glyph
// reuses the access-indicator hues precedent (shield = restricted/private, members = workspace/public).
export function ProjectVisibilityBadge({
  visibility,
  projectId,
}: {
  visibility: ProjectVisibility;
  projectId?: string;
}) {
  const isPublic = visibility === "public";
  return (
    <span
      data-testid={projectId ? `proj-visibility-${projectId}` : undefined}
      className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted"
    >
      <Icon name={isPublic ? "members" : "shield"} size={11} />
      {isPublic ? "Public" : "Private"}
    </span>
  );
}
