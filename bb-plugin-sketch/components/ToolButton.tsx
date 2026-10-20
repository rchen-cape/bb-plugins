import { forwardRef, type MouseEvent, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { keepRootFocus } from "./bits";
import { Button, type ButtonProps } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type ToolButtonProps = Omit<ButtonProps, "children"> & {
  readonly label: string;
  readonly tooltip?: string;
  readonly hint?: string;
  readonly pressed?: boolean;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly children: ReactNode;
};

export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton(
  { label, tooltip, hint, pressed, side = "bottom", className, children, onMouseDown, ...props },
  ref,
) {
  const onPress = (event: MouseEvent<HTMLButtonElement>) => {
    onMouseDown?.(event);
    keepRootFocus(event);
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={pressed}
          className={cn("relative size-8 shrink-0 text-muted-foreground hover:text-foreground aria-pressed:text-foreground", className)}
          onMouseDown={onPress}
          {...props}
        >
          {children}
          {hint === undefined ? null : (
            <span aria-hidden="true" className="pointer-events-none absolute bottom-0.5 right-1 font-mono text-2xs leading-none opacity-60">
              {hint}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
});
