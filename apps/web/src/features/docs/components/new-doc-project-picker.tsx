import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Icon } from "@/components/icon";
import { ProjectVisibilityBadge } from "./project-visibility-badge";
import type { GeneralAccess, ProjectRow } from "@/features/docs/types";

// The project picker for the New-doc dialog (workspace-project-ui S-003). The doc the author
// publishes lands in the chosen project instead of always the default. The list is the active
// workspace's projects ONLY (C-003) — the caller passes the workspace-scoped, active list.
// Extracted from new-doc-dialog.tsx to keep that file under the 350-line lint threshold.

export function NewDocProjectPicker({
  projects,
  value,
  onChange,
  disabled,
}: {
  projects: ProjectRow[];
  value: string;
  onChange: (projectId: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor="new-doc-project"
        className="mb-1.5 block text-[12px] font-medium text-muted"
      >
        Project
      </label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          id="new-doc-project"
          data-testid="new-doc-project"
          aria-label="Project"
          className="w-full"
        >
          <SelectValue placeholder="Choose a project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem
              key={p.id}
              value={p.id}
              textValue={p.name}
              data-testid={`project-option-${p.id}`}
            >
              <span className="flex items-center gap-2">
                <span>
                  {p.name}
                  {p.isDefault ? " (Default)" : ""}
                </span>
                {/* project-visibility-fe S-002 / AS-007: a Private/Public pill per option, read from
                    the row's server `visibility` (C-001). Absent on a legacy row → no badge. */}
                {p.visibility && <ProjectVisibilityBadge visibility={p.visibility} />}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// project-visibility-fe S-002 / AS-008 / C-001. The new-doc access hint DISPLAYS the server-derived
// `newDocAccess` of the selected project — it never recomputes the carve-out. `restricted` → the doc
// will be private; `anyone_in_workspace` → visible to the workspace (which is what the default
// private-shell project carries via the server carve-out, so a private default still reads "visible
// to your workspace" here, not "private"). Absent/unrecognized → render nothing (null-safe).
export function NewDocAccessHint({ access }: { access?: GeneralAccess }) {
  if (access !== "restricted" && access !== "anyone_in_workspace") return null;
  const isPrivate = access === "restricted";
  return (
    <p
      data-testid="new-doc-access-hint"
      className="-mt-1 flex items-center gap-1.5 text-[12px] text-muted"
    >
      <Icon name={isPrivate ? "shield" : "members"} size={12} />
      {isPrivate
        ? "This doc will be private — only you can access it."
        : "This doc will be visible to your workspace."}
    </p>
  );
}
