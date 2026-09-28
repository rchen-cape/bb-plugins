import { useState, type DragEvent, type ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { imageMimeType, type ReferencedImage } from "../src/images";

/*
 * A drop carries more than images — a dragged file from the desktop, a
 * selection of several, sometimes a URL. Only the images are ours, and the
 * name decides, because a browser's own type for a dropped file is not
 * something to rely on for what the server will accept.
 */
export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (transfer === null) return [];
  return [...transfer.files].filter(
    (file) => imageMimeType(file.name) !== null,
  );
}

export function hasImageFiles(transfer: DataTransfer | null): boolean {
  if (transfer === null) return false;
  if (transfer.files.length > 0) return imageFilesFrom(transfer).length > 0;
  // Mid-drag, Safari and Chrome expose kinds but not names.
  return [...transfer.items].some((item) => item.kind === "file");
}

const CHUNK_SIZE = 0x8000;

/** Chunked, because spreading a megabyte of bytes into a call overflows. */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

/*
 * Wraps whatever is being written into, so an image can be dropped anywhere
 * over the document rather than onto a target the user has to find.
 */
export function ImageDropZone({
  disabled,
  onDropImages,
  children,
}: {
  disabled: boolean;
  onDropImages: (files: File[]) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const leave = (event: DragEvent<HTMLDivElement>) => {
    // A drag crossing a child fires leave on the parent; only the real exit counts.
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    setOver(false);
  };
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        over && !disabled
          ? "rounded-md ring-1 ring-ring ring-offset-2 ring-offset-background"
          : "",
      )}
      onDragOver={(event) => {
        if (disabled || !hasImageFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={leave}
      onDrop={(event) => {
        if (disabled) return;
        const files = imageFilesFrom(event.dataTransfer);
        setOver(false);
        if (files.length === 0) return;
        event.preventDefault();
        onDropImages(files);
      }}
    >
      {children}
      {over && !disabled ? (
        <p
          className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-2xs text-subtle-foreground"
          role="status"
        >
          Drop to add the image to this note
        </p>
      ) : null}
    </div>
  );
}

/*
 * What the note carries, under the text that refers to it. The editor is a
 * plain textarea — by design, so a note reads as a file — which means the
 * references in it are text, and this is where they become pictures.
 */
export function NoteImageStrip({
  images,
  baseUrl,
  pending,
}: {
  images: readonly ReferencedImage[];
  baseUrl: string | null;
  pending: number;
}) {
  if (images.length === 0 && pending === 0) return null;
  return (
    <div className="shrink-0 space-y-1 border-t border-border/60 pt-1.5">
      <p className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        {images.length === 1 ? "1 image" : `${images.length} images`}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {images.map((image) => (
          <li key={image.assetFile} className="min-w-0">
            {baseUrl === null ? (
              <span className="block max-w-32 truncate rounded border border-border bg-muted/40 px-1.5 py-1 text-2xs text-subtle-foreground">
                {image.alt}
              </span>
            ) : (
              <img
                src={`${baseUrl.replace(/\/$/u, "")}/${encodeURIComponent(image.assetFile)}`}
                alt={image.alt}
                title={image.alt}
                loading="lazy"
                className="size-16 rounded border border-border object-cover"
              />
            )}
          </li>
        ))}
        {pending > 0 ? (
          <li
            className="flex size-16 items-center justify-center rounded border border-dashed border-border text-2xs text-subtle-foreground"
            role="status"
          >
            adding…
          </li>
        ) : null}
      </ul>
    </div>
  );
}
