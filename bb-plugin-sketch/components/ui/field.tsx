import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

interface FieldProps {
  label: string;
  group?: boolean;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

function Field({ label, group = false, hint, className, children }: FieldProps) {
  const Wrapper = group ? "div" : "label";
  return (
    <Wrapper
      className={cn("grid gap-1.5 text-sm", className)}
      {...(group ? { role: "group", "aria-label": label } : {})}
    >
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint === undefined ? null : (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </Wrapper>
  );
}

export { Field };
