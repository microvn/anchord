import { useState } from "react";
import { Icon } from "@/components/icon";

// ImageViewer (S-001/AS-003, C-001): renders a kind=image doc with zoom in/out. The image is
// loaded from the sandboxed /v/:id content route (same isolation rationale as the HTML frame —
// the app never restyles the artifact). Zoom is a client transform on a scale step; clamped to
// [0.6, 3] so the controls can't run away. G11 (suggest-image) will layer pan + a region overlay
// on top of this; S-001 only needs display + zoom.

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 3;
const STEP = 0.2;

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

export function ImageViewer({ contentUrl }: { contentUrl: string }) {
  const [zoom, setZoom] = useState(1);

  return (
    <div className="px-5 pb-[120px] pt-[14px]">
      <div
        data-testid="image-viewer"
        className="relative mx-auto flex min-h-[360px] max-w-[760px] items-center justify-center overflow-hidden rounded-md border border-line bg-sunken p-6"
      >
        <img
          data-testid="image-viewer-img"
          src={contentUrl}
          alt="doc"
          style={{ transform: `scale(${zoom})`, transition: "transform .15s" }}
          className="max-w-full"
        />
        <div className="absolute bottom-[14px] right-[14px] flex gap-1">
          <button
            type="button"
            aria-label="Zoom out"
            className="grid size-8 place-items-center rounded-md border border-line bg-surface text-ink hover:bg-elev"
            onClick={() => setZoom((z) => clamp(z - STEP))}
          >
            <Icon name="chevDown" size={15} />
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            className="grid size-8 place-items-center rounded-md border border-line bg-surface text-ink hover:bg-elev"
            onClick={() => setZoom((z) => clamp(z + STEP))}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
