import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full border border-white/10 p-[2px] transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0e19]",
      "disabled:cursor-not-allowed disabled:opacity-40",
      "data-[state=checked]:border-transparent data-[state=checked]:bg-[var(--hud-accent)] data-[state=checked]:shadow-[0_0_14px_-2px_var(--hud-accent)]",
      "data-[state=unchecked]:bg-white/[0.14] data-[state=unchecked]:shadow-[inset_0_1px_2px_rgb(0_0_0/0.3)]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.35)] ring-0 transition-transform",
        "data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
