import { useEffect, useRef, useState } from "react";
import type { WikiSuggestion } from "../contract";
import { LIMITS } from "../lib/sketch.js";
import { useSketchRpc } from "./hooks";

const SUGGEST_DEBOUNCE_MS = 300;

export type WikiSuggestions = { readonly list: readonly WikiSuggestion[]; readonly settled: boolean };

export function useWikiSuggestions(text: string, title: string): WikiSuggestions {
  const rpc = useSketchRpc();
  const [state, setState] = useState<WikiSuggestions>({ list: [], settled: false });
  const first = useRef(true);
  useEffect(() => {
    let cancelled = false;
    const delay = first.current ? 0 : SUGGEST_DEBOUNCE_MS;
    first.current = false;
    const timer = setTimeout(() => {
      rpc.call("wikiSuggest", { text: text.slice(0, LIMITS.note), title: title.slice(0, LIMITS.title) }).then(
        (result) => {
          if (!cancelled) setState({ list: result.suggestions, settled: true });
        },
        () => {
          if (!cancelled) setState((current) => ({ list: current.list, settled: true }));
        },
      );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, text, title]);
  return state;
}
