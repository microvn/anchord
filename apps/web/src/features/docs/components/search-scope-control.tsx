import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectRow } from "@/features/docs/types";

// The search-scope control (workspace-project-ui S-004, GAP-003 accepted design — no prototype).
// A Select listing "All workspace" plus the active workspace's projects (C-003 — this workspace
// only). Picking a project scopes the search to it (AS-010); picking "All workspace" broadens
// back to every accessible doc (AS-011). The selected value drives the `projectId` the search
// hook threads to `searchDocs`. Consistent with the system's `Select` (same as NewDocProjectPicker).

/** Sentinel option value for the whole-workspace scope (Radix Select disallows an empty string). */
export const ALL_WORKSPACE = "__all__";

export function SearchScopeControl({
  projects,
  value,
  onChange,
}: {
  projects: ProjectRow[];
  /** The selected project id, or undefined for whole-workspace scope. */
  value: string | undefined;
  /** Called with the project id, or undefined when the user picks "All workspace". */
  onChange: (projectId: string | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-2" data-testid="search-scope">
      <span className="text-[12px] text-muted">Scope</span>
      <Select
        value={value ?? ALL_WORKSPACE}
        onValueChange={(v) => onChange(v === ALL_WORKSPACE ? undefined : v)}
      >
        <SelectTrigger
          data-testid="search-scope-trigger"
          aria-label="Search scope"
          size="sm"
          className="w-[200px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_WORKSPACE} data-testid="scope-option-all">
            All workspace
          </SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id} data-testid={`scope-option-${p.id}`}>
              In {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
