import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";

// A confirmation gate for destructive deletes/removes. Wraps the shadcn/radix AlertDialog
// primitive (focus-trap + Esc + Cancel = the safe default) and themes it to the Anchord
// `@theme` tokens, matching the create/rename Dialog look: a CENTERED modal box (radius 11,
// surface bg, line border, shadow-modal) over the full-viewport `--scrim`. Only the action
// button (Button variant="destructive" — the `.btn.danger` taxonomy) runs `onConfirm`.
//
// `trigger` is the element that opens the dialog (e.g. the trash icon button). We keep its
// own testid/handlers intact by passing it through `asChild`, so the existing trigger STILL
// opens the flow — the mutation just moves behind the confirm.
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  confirmTestId,
}: {
  trigger: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  confirmTestId?: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent
        // Anchord-Design `.scrim` — full-viewport teal-black scrim (the --scrim token).
        overlayClassName="bg-[var(--scrim)]"
        // Match the create/rename `.dialog`: 440 wide, radius 11, line border, shadow-modal,
        // no inner padding (head/foot own their own). gap-0 cancels shadcn's grid gap.
        className="w-full max-w-[440px] gap-0 rounded-[11px] border border-line bg-surface p-0 shadow-[var(--shadow-modal)] data-[size=default]:sm:max-w-[440px]"
      >
        {/* head — 18/18/0 */}
        <AlertDialogHeader className="block gap-0 p-[18px] pb-0 text-left sm:place-items-start sm:text-left">
          <AlertDialogTitle className="font-serif text-[21px] font-medium leading-[1.05] tracking-[-0.03em] text-ink">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-[3px] text-[12.5px] text-muted">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* foot — head/body collapse to head only; foot 16/18/18, gap 8, justify-end */}
        <AlertDialogFooter className="flex flex-row justify-end gap-2 px-[18px] pt-4 pb-[18px]">
          <AlertDialogCancel variant="secondary" className="mt-0">
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-testid={confirmTestId} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
