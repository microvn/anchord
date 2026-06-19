import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { DayPicker, getDefaultClassNames } from "react-day-picker"

import { cn } from "@/lib/utils"

// react-day-picker v10 DayPicker wrapper, themed to Anchord's dark-operator tokens
// (bg-elev / border-line / text-subtle / bg-accent). Generic + reusable — pass
// `mode`, `selected`, `onSelect`, `disabled` etc. straight through.
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaults = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-1", className)}
      classNames={{
        root: cn(defaults.root, "text-ink"),
        months: cn(defaults.months, "relative flex flex-col gap-3"),
        month: cn(defaults.month, "flex flex-col gap-3"),
        month_caption: cn(
          defaults.month_caption,
          "flex h-8 items-center justify-center px-8",
        ),
        caption_label: cn(defaults.caption_label, "text-[13px] font-medium text-ink"),
        nav: cn(defaults.nav, "absolute inset-x-0 top-0 flex items-center justify-between"),
        button_previous: cn(
          defaults.button_previous,
          "inline-flex size-7 items-center justify-center rounded-[6px] border border-line bg-surface text-subtle transition-colors hover:border-subtle hover:text-ink disabled:opacity-40",
        ),
        button_next: cn(
          defaults.button_next,
          "inline-flex size-7 items-center justify-center rounded-[6px] border border-line bg-surface text-subtle transition-colors hover:border-subtle hover:text-ink disabled:opacity-40",
        ),
        month_grid: cn(defaults.month_grid, "w-full border-collapse"),
        weekdays: cn(defaults.weekdays, "flex"),
        weekday: cn(
          defaults.weekday,
          "w-8 flex-none text-[11px] font-normal text-subtle",
        ),
        week: cn(defaults.week, "mt-1 flex w-full"),
        day: cn(defaults.day, "size-8 flex-none p-0 text-center"),
        day_button: cn(
          defaults.day_button,
          "inline-flex size-8 items-center justify-center rounded-[6px] text-[12.5px] text-ink outline-none transition-colors hover:bg-elev2 focus-visible:ring-2 focus-visible:ring-accent",
        ),
        today: cn(defaults.today, "[&>button]:font-semibold [&>button]:text-accent-ink"),
        selected: cn(
          defaults.selected,
          "[&>button]:bg-accent [&>button]:text-on-accent [&>button:hover]:bg-accent-strong",
        ),
        outside: cn(defaults.outside, "[&>button]:text-faint"),
        disabled: cn(defaults.disabled, "[&>button]:cursor-not-allowed [&>button]:text-faint [&>button:hover]:bg-transparent"),
        hidden: cn(defaults.hidden, "invisible"),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevClass, ...chevProps }) => {
          const Comp = orientation === "left" ? ChevronLeftIcon : ChevronRightIcon
          return <Comp className={cn("size-4", chevClass)} {...chevProps} />
        },
      }}
      {...props}
    />
  )
}

export { Calendar }
