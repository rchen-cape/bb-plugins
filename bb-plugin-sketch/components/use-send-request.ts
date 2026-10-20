import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "./bits";

export type SendRequest = {
  readonly busy: boolean;
  readonly error: string | null;
  readonly run: (task: () => Promise<void>) => Promise<void>;
};

export function useSendRequest(): SendRequest {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      const message = errorMessage(cause);
      if (mounted.current) setError(message);
      else toast.error(`Couldn't send to the Wiki: ${message}`);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { busy, error, run };
}
