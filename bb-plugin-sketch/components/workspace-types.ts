import type { Scene } from "../lib/scene.js";

export type OpenDoc = {
  readonly key: string;
  readonly id: string | null;
  readonly title: string;
  readonly sha256: string | null;
  readonly scene: Scene;
};

export type PageActions = {
  readonly open: (id: string) => void;
  readonly create: () => void;
  readonly importFile: (file: File) => void;
  readonly identify: (id: string, title: string) => void;
  readonly deleted: (id: string) => void;
};
