import type { UploadInfo } from "../contract";

export type AddRequest =
  | { kind: "message"; threadId: string; messageId: string; messageSeq: number | null; text: string; fromSelection: boolean }
  | { kind: "code"; threadId: string; messageId: string; code: string; language: string }
  | { kind: "uploads"; uploads: UploadInfo[] };

export interface Channel<T> {
  emit(value: T): boolean;
  subscribe(listener: (value: T) => void): () => void;
}

export function channel<T>(): Channel<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    emit(value: T): boolean {
      listeners.forEach((listener) => listener(value));
      return listeners.size > 0;
    },
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const addRequests = channel<AddRequest>();
export const searchRequests = channel<null>();
export const restoredCards = channel<string>();
