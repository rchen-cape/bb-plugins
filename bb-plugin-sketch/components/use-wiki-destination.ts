import { useState } from "react";
import type { WikiDestination, WikiDoc } from "../contract";
import { defaultHeading, destinationFor, initialChoice, type DocChoice, type InitialChoiceInput, type Kind } from "./wiki-destination";
import { headingText, type HeadingValue } from "./WikiDocField";

export type WikiDestinationState = {
  readonly choice: DocChoice | null;
  readonly doc: WikiDoc | undefined;
  readonly heading: HeadingValue;
  readonly pick: (choice: DocChoice) => void;
  readonly setHeading: (heading: HeadingValue) => void;
  readonly destination: (kind: Kind) => WikiDestination | null;
};

export function useWikiDestination(input: InitialChoiceInput): WikiDestinationState {
  const [picked, setPicked] = useState<DocChoice | null>(null);
  const [auto, setAuto] = useState<DocChoice | null | undefined>(undefined);
  const [heading, setHeading] = useState<HeadingValue | null>(null);
  if (auto === undefined) {
    const decided = picked !== null || heading !== null ? null : initialChoice(input);
    if (decided !== undefined) setAuto(decided);
  }
  const choice = picked ?? auto ?? null;
  const headingValue = heading ?? { value: defaultHeading(choice), custom: "" };
  return {
    choice,
    doc: choice === null ? undefined : input.docs?.find((candidate) => candidate.slug === choice.slug),
    heading: headingValue,
    pick: (next) => {
      setPicked(next);
      setHeading(null);
    },
    setHeading,
    destination: (kind) => destinationFor(kind, choice, headingText(headingValue)),
  };
}
