import type { GeneralAccess, PublishResult } from "@/features/docs/types";

// project-visibility-fe S-004 / AS-016 / AS-017 / C-001. The post-publish notice: it tells the author
// WHERE the doc landed and WHO can see it — both read straight from the publish response (web publish
// AND MCP create, project-visibility:AS-029), never recomputed in the FE. It is null-safe: a response
// with `project: null` (or `project.name: null`, or an unrecognized `access`) omits the missing clause
// rather than rendering "in ****" or dereferencing null, and never crashes the success surface.

/** Map the server's resulting access level to the notice's access clause. An access value not in this
 *  map (unrecognized/absent) yields no clause — the FE shows only what the server reported (C-001). */
const ACCESS_COPY: Record<GeneralAccess, string> = {
  anyone_in_workspace: "visible to your workspace",
  restricted: "private — only you",
  anyone_with_link: "anyone with the link",
};

export function PublishAccessNotice({
  project,
  access,
}: {
  project?: PublishResult["project"];
  access?: PublishResult["access"];
}) {
  // `project` and `project.name` are both nullable; collapse to a usable name or nothing.
  const name = project?.name ?? null;
  // An unrecognized `access` is not in ACCESS_COPY → undefined → the access clause is omitted.
  const accessCopy = access ? ACCESS_COPY[access] : undefined;

  // Nothing reportable (no project AND no recognized access) → render nothing, never an empty shell.
  if (!name && !accessCopy) return null;

  return (
    <span
      data-testid="publish-access-notice"
      className="inline-flex flex-wrap items-center gap-1 text-[12px] text-muted"
    >
      {name ? (
        <span>
          in <strong className="font-semibold text-ink">{name}</strong>
        </span>
      ) : null}
      {accessCopy ? (
        <span>
          {name ? " " : null}· {accessCopy}
        </span>
      ) : null}
    </span>
  );
}
