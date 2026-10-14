export const BOARD_PANEL = "board";

export interface PullRoute {
  repo: string;
  number: number;
}

export function workspacePath(pull: PullRoute): string {
  return `pr/${pull.repo}/${pull.number}`;
}

export function parseWorkspacePath(subPath: string): PullRoute | null {
  const match = /^pr\/([\w.-]+)\/([\w.-]+)\/(\d+)\/?$/.exec(subPath);
  if (match === null) return null;
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

export const REVIEW_THREAD_TAB = { panelId: BOARD_PANEL, id: "thread" } as const;
export const ADDRESS_THREAD_TAB = { panelId: BOARD_PANEL, id: "address-thread" } as const;
