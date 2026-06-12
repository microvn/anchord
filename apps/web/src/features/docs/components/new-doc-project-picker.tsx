import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectRow } from "@/features/docs/types";

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
            <SelectItem key={p.id} value={p.id} data-testid={`project-option-${p.id}`}>
              {p.name}
              {p.isDefault ? " (Default)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
