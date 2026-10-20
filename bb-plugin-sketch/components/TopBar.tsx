import type { ReactNode } from "react";
import { SendButton } from "./SendButton";
import { Toolbar } from "./Toolbar";

export function TopBar({ menu }: { menu: ReactNode }) {
  return (
    <div data-sketch-top-bar="" className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 @3xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="flex min-w-0">
          <div className="pointer-events-auto flex min-w-0">{menu}</div>
        </div>
        <div className="col-span-2 row-start-2 flex min-w-0 justify-center @3xl:col-span-1 @3xl:col-start-2 @3xl:row-start-1">
          <div className="pointer-events-auto flex min-w-0 max-w-full">
            <Toolbar />
          </div>
        </div>
        <div className="pointer-events-auto flex justify-self-end @3xl:col-start-3 @3xl:row-start-1">
          <SendButton />
        </div>
      </div>
    </div>
  );
}
