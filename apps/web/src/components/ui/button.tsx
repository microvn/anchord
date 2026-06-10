import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Rebuilt on the Anchord-Design `.btn` taxonomy (tokens.css):
//   base `.btn`  → inline-flex / gap 7px / 600 / radius 8 (--r-md) / 1px transparent border
//   default size → h32 / px12 / 12.5px (the `.btn` base height)
//   sm           → h28 / px10 (`.btn.sm`)
//   lg           → h40 / px16 / 13.5px / radius 11 (`.btn.lg` — the auth submit; do NOT shrink)
//   default var  → `.btn.primary` (teal accent)
//   secondary    → `.btn.secondary`   ghost → `.btn.ghost`   destructive → `.btn.danger`
// Icons are sized 15px to match `.btn svg`. Variant/size prop NAMES stay the shadcn set so
// existing call-sites keep type-checking.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-[7px] whitespace-nowrap select-none rounded-[8px] border border-transparent font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[15px]",
  {
    variants: {
      variant: {
        // `.btn.primary`
        default: "bg-accent text-on-accent hover:bg-accent-strong",
        // `.btn.danger`
        destructive:
          "bg-transparent text-error border-line hover:border-error hover:bg-error/10",
        // shadcn `outline` ≈ Anchord `.btn.secondary`
        outline:
          "bg-surface text-ink border-line hover:bg-elev hover:border-subtle",
        // `.btn.secondary`
        secondary:
          "bg-surface text-ink border-line hover:bg-elev hover:border-subtle",
        // `.btn.ghost`
        ghost: "bg-transparent text-muted border-transparent hover:bg-elev hover:text-ink",
        link: "text-accent border-transparent underline-offset-4 hover:underline",
      },
      size: {
        // `.btn` base — h32 / 12.5px / px12
        default: "h-8 px-3 text-[12.5px]",
        // `.btn.sm` — h28 / px10
        sm: "h-7 px-2.5 text-[12.5px]",
        // `.btn.lg` — h40 / 13.5px / px16 / radius 11 (auth submit)
        lg: "h-10 px-4 text-[13.5px] rounded-[11px]",
        // square icon button at the h32 base
        icon: "size-8",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
