// ShareDialog prefill-loading skeleton. It MIRRORS the editable sections' layout (same
// `flex-col gap-4 pt-1` wrapper as ShareSections) so the dialog opens at roughly its settled
// height and the prefill read swaps content IN PLACE — instead of flipping a tiny one-line box
// into the full dialog, which grew + re-centered the modal and read as "two popups" on the first
// open after a refresh (before the share-state read is cached).

function Bar({ w, h = 12 }: { w: string; h?: number }) {
  return <div className="rounded bg-sunken" style={{ width: w, height: h }} />;
}

export function ShareLoadingSkeleton() {
  return (
    <div data-testid="share-loading" aria-busy="true" className="flex animate-pulse flex-col gap-4 pt-1">
      {/* General access (label + segmented + role + hint) */}
      <div className="flex flex-col gap-2">
        <Bar w="92px" />
        <div className="flex gap-2">
          <Bar w="100%" h={38} />
          <Bar w="120px" h={38} />
        </div>
        <Bar w="70%" h={11} />
      </div>
      {/* guest toggle row + editors toggle row */}
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <Bar w="150px" />
            <Bar w="220px" h={10} />
          </div>
          <Bar w="34px" h={20} />
        </div>
      ))}
      {/* invite row */}
      <div className="flex flex-col gap-2">
        <Bar w="92px" />
        <Bar w="100%" h={38} />
        <Bar w="100%" h={34} />
      </div>
      {/* one person row */}
      <div className="flex items-center gap-3">
        <Bar w="32px" h={32} />
        <div className="flex flex-1 flex-col gap-1.5">
          <Bar w="40%" />
          <Bar w="60%" h={10} />
        </div>
        <Bar w="96px" h={28} />
      </div>
    </div>
  );
}
