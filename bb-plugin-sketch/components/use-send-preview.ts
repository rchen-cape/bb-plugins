import { useEffect, useState } from "react";
import type { SketchElement } from "../lib/scene.js";
import { errorMessage } from "./bits";
import { blobToBase64, objectUrl, renderPng, revokeUrl, type PngImage } from "./export-png";

export type SendPreview =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly image: PngImage; readonly base64: string; readonly url: string | null }
  | { readonly status: "error"; readonly message: string };

export function useSendPreview(elements: readonly SketchElement[]): SendPreview {
  const [state, setState] = useState<SendPreview>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setState({ status: "loading" });
    renderPng(elements)
      .then(async (image) => {
        const base64 = await blobToBase64(image.blob);
        if (cancelled) return;
        url = objectUrl(image.blob);
        setState({ status: "ready", image, base64, url });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
      revokeUrl(url);
    };
  }, [elements]);
  return state;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
