import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Icon } from "../../components/icon";
import { useActiveWorkspaceSafe } from "../workspaces/active-workspace";
import { queryKeys } from "../workspaces/query-keys";
import { unwrapEnvelope } from "../workspaces/use-bootstrap";
import { toApiError } from "../../lib/api-error";
import { publishDoc } from "./client";
import type { PublishResult } from "./types";

// NewDocDialog (render-publish S-001) — Upload / Paste / via-MCP tabs, 1:1 with
// Anchord-Design's NewDocDialog (dialogs2.jsx). Caps: 5 MB for text, 25 MB for images
// (AS-004); unsupported type (AS-005) and empty (AS-014) are rejected inline BEFORE the
// request. Title is auto-inferred from the file name (and editable). Publish → the JSON
// publish variant POST /api/w/:id/docs (the route reads { content, kind?, title? }; the
// multipart file variant is deferred backend-side, so Upload reads the file's text and
// sends it as content). On success: invalidate the workspace docs cache, toast, and
// navigate to the new doc's viewer (/d/:slug).

const TEXT_CAP = 5 * 1024 * 1024; // 5 MB
const IMAGE_CAP = 25 * 1024 * 1024; // 25 MB

type Kind = "markdown" | "html" | "image";
type Tab = "upload" | "paste" | "mcp";

function kindForFile(name: string, type: string): Kind | null {
  const ext = name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "";
  if (ext === "md" || ext === "markdown" || type === "text/markdown") return "markdown";
  if (ext === "html" || ext === "htm" || type === "text/html") return "html";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "svg" || type.startsWith("image/")) {
    return "image";
  }
  return null;
}

function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim();
}

/** The teal "New doc" button that opens the dialog. Reused by the dashboard + the All-docs head. */
export function NewDocButton({
  testid = "new-doc-button",
  workspaceId,
}: {
  testid?: string;
  workspaceId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testid}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-strong"
      >
        <Icon name="plus" size={16} />
        New doc
      </button>
      <NewDocDialog open={open} onOpenChange={setOpen} workspaceId={workspaceId} />
    </>
  );
}

export function NewDocDialog({
  open,
  onOpenChange,
  workspaceId: workspaceIdProp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Explicit workspace id for callers outside the WorkspaceRouteGuard (e.g. the sidebar). */
  workspaceId?: string;
}) {
  // Prefer an explicit id (sidebar, above the route guard); else read the active workspace.
  const ctxWorkspace = useActiveWorkspaceSafe();
  const workspace = { id: workspaceIdProp ?? ctxWorkspace?.id ?? "" };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>("upload");
  const [file, setFile] = useState<{ name: string; content: string; kind: Kind } | null>(null);
  const [paste, setPaste] = useState("");
  const [pasteKind, setPasteKind] = useState<Kind>("markdown");
  const [title, setTitle] = useState("");
  const [reject, setReject] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function resetAll() {
    setTab("upload");
    setFile(null);
    setPaste("");
    setPasteKind("markdown");
    setTitle("");
    setReject(null);
    setSubmitting(false);
  }

  async function onFilePicked(picked: File) {
    setReject(null);
    const kind = kindForFile(picked.name, picked.type);
    if (!kind) {
      setReject("Unsupported type. Use .html, .md, or an image.");
      return;
    }
    const cap = kind === "image" ? IMAGE_CAP : TEXT_CAP;
    if (picked.size > cap) {
      setReject(`File is over the ${kind === "image" ? "25 MB" : "5 MB"} limit.`);
      return;
    }
    const content = await picked.text();
    setFile({ name: picked.name, content, kind });
    setTitle((t) => t || titleFromFilename(picked.name));
  }

  const canPublish =
    tab === "upload" ? !!file : tab === "paste" ? paste.trim().length > 0 : false;

  async function onPublish() {
    setReject(null);
    const body =
      tab === "upload" && file
        ? { content: file.content, kind: file.kind, title: title.trim() || undefined }
        : tab === "paste"
          ? { content: paste, kind: pasteKind, title: title.trim() || undefined }
          : null;
    if (!body || !body.content.trim()) {
      setReject("Add a file or paste some content to publish.");
      return;
    }

    setSubmitting(true);
    try {
      const res = unwrapEnvelope<PublishResult>(await publishDoc(workspace.id, body));
      if (res.error) {
        setReject(toApiError(res.error).message);
        setSubmitting(false);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.docs(workspace.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspace.id) });
      toast.success(`Published “${body.title ?? res.data?.slug ?? "doc"}”`);
      onOpenChange(false);
      resetAll();
      if (res.data?.slug) navigate(`/d/${res.data.slug}`);
    } catch (thrown) {
      setReject(toApiError(thrown).message);
      setSubmitting(false);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "upload", label: "Upload" },
    { id: "paste", label: "Paste" },
    { id: "mcp", label: "via MCP" },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) resetAll();
      }}
    >
      <DialogContent
        data-testid="new-doc-dialog"
        // Anchord-Design `.scrim` — full-viewport teal-black scrim (the --scrim token), matching
        // the create/rename dialogs (not the shadcn black/50 default).
        overlayClassName="bg-[var(--scrim)]"
        className="border-line bg-surface sm:max-w-[520px]"
      >
        <DialogHeader>
          <DialogTitle className="font-serif text-[21px] font-medium text-ink">
            New doc
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted">
            Publish an artifact into the default project.
          </DialogDescription>
        </DialogHeader>

        {/* source tabs */}
        <div className="flex gap-1 border-b border-line" data-testid="new-doc-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`tab-${t.id}`}
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setReject(null);
              }}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
                tab === t.id
                  ? "border-accent font-semibold text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "upload" && (
          <div>
            {!file ? (
              <button
                type="button"
                data-testid="dropzone"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full flex-col items-center gap-1 rounded-md border-[1.5px] border-dashed border-line bg-elev px-5 py-[30px] text-center transition-colors hover:border-accent hover:bg-accent-soft"
              >
                <span className="grid size-10 place-items-center rounded-md text-subtle">
                  <Icon name="upload" size={22} />
                </span>
                <span className="text-[13px] font-semibold text-ink">
                  Drop a file or click to browse
                </span>
                <span className="text-[12px] text-subtle">
                  .html · .md · image — up to 5 MB (25 MB image)
                </span>
              </button>
            ) : (
              <div
                data-testid="picked-file"
                className="flex items-center gap-2 rounded-md border border-line bg-elev px-3 py-2"
              >
                <span className="grid size-7 place-items-center rounded-sm bg-accent-soft text-accent-ink">
                  <Icon name="docs" size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                  {file.name}
                </span>
                <button
                  type="button"
                  aria-label="Remove file"
                  data-testid="remove-file"
                  onClick={() => {
                    setFile(null);
                    setTitle("");
                  }}
                  className="text-subtle hover:text-ink"
                >
                  <Icon name="x" size={15} />
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              data-testid="file-input"
              className="sr-only"
              accept=".html,.htm,.md,.markdown,image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFilePicked(f);
              }}
            />
          </div>
        )}

        {tab === "paste" && (
          <div>
            <textarea
              data-testid="paste-area"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="Paste HTML or Markdown…"
              className="min-h-[160px] w-full resize-y rounded-md border border-line bg-sunken p-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
            />
            <div className="mt-2 flex items-center gap-3">
              <span className="text-[12px] text-muted">Format</span>
              <div className="flex gap-0.5 rounded-md border border-line bg-sunken p-0.5">
                {(["markdown", "html"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    data-testid={`paste-fmt-${f}`}
                    aria-pressed={pasteKind === f}
                    onClick={() => setPasteKind(f)}
                    className={`rounded-sm px-3 py-1 text-[12.5px] transition-colors ${
                      pasteKind === f ? "bg-surface text-accent-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {f === "html" ? "HTML" : "Markdown"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "mcp" && (
          <div className="rounded-[11px] border border-line bg-sunken p-4" data-testid="mcp-pane">
            <div className="text-[14px] font-semibold text-ink">Publish from your agent</div>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">
              Point your MCP-enabled agent at this workspace. Docs published via MCP land in the
              default project automatically.
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">
                Endpoint
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                /mcp/w/{workspace.id}
              </code>
              <button
                type="button"
                aria-label="Copy endpoint"
                onClick={() => {
                  void navigator.clipboard?.writeText(`/mcp/w/${workspace.id}`);
                  toast.success("Endpoint copied");
                }}
                className="text-subtle hover:text-ink"
              >
                <Icon name="copy" size={15} />
              </button>
            </div>
          </div>
        )}

        {tab !== "mcp" && (
          <div>
            <label
              htmlFor="new-doc-title"
              className="mb-1.5 block text-[12px] font-medium text-muted"
            >
              Title
            </label>
            <input
              id="new-doc-title"
              data-testid="new-doc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Auto-inferred from the file or first heading"
              className="h-9 w-full rounded-md border border-line bg-surface px-[11px] text-[13.5px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            />
          </div>
        )}

        {reject && (
          <div
            role="alert"
            data-testid="new-doc-error"
            className="flex items-center gap-2 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-[12.5px] text-error"
          >
            <Icon name="alert" size={14} />
            {reject}
          </div>
        )}

        {tab !== "mcp" && (
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="min-h-[40px] rounded-md border border-line bg-surface px-4 text-[13px] text-ink hover:border-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="publish-button"
              disabled={!canPublish || submitting}
              onClick={() => void onPublish()}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-md bg-accent px-4 text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="arrowRight" size={15} />
              {submitting ? "Publishing…" : "Publish"}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
