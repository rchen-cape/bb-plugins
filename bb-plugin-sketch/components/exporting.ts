import { toast } from "sonner";
import { serializeScene, type SceneAppState } from "../lib/scene.js";
import { errorMessage } from "./bits";
import type { EditorController } from "./controller";
import { copyPngToClipboard, downloadBlob, downloadName, exportSvg, renderPng } from "./export-png";
import { exportTargets } from "./scene-actions";
import type { ExportKind } from "./SketchMenu";

export type ExportFile = { readonly title: string; readonly appState: SceneAppState; readonly files: Record<string, unknown> };

function nothingToExport(controller: EditorController): boolean {
  if (controller.state.elements.some((element) => !element.isDeleted)) return false;
  toast.message("Draw something first.");
  return true;
}

async function exportFile(controller: EditorController, kind: ExportKind, file: ExportFile): Promise<void> {
  if (kind === "excalidraw") {
    const content = serializeScene({
      elements: controller.state.elements,
      appState: { ...file.appState, gridModeEnabled: controller.state.grid },
      files: file.files,
    });
    downloadBlob(new Blob([content], { type: "application/json" }), downloadName(file.title, "excalidraw"));
    return;
  }
  if (nothingToExport(controller)) return;
  const targets = exportTargets(controller);
  if (kind === "svg") {
    downloadBlob(new Blob([exportSvg(targets).svg], { type: "image/svg+xml" }), downloadName(file.title, "svg"));
    return;
  }
  const png = await renderPng(targets);
  downloadBlob(png.blob, downloadName(file.title, "png"));
}

export function runExport(controller: EditorController, kind: ExportKind, file: ExportFile): void {
  exportFile(controller, kind, file).catch((cause: unknown) => toast.error(`Couldn't export: ${errorMessage(cause)}`));
}

export function copyAsPng(controller: EditorController): void {
  if (nothingToExport(controller)) return;
  const png = renderPng(exportTargets(controller)).then((image) => image.blob);
  png.catch(() => undefined);
  copyPngToClipboard(png).then(
    () => toast.success("Copied as PNG"),
    (cause: unknown) => toast.error(`Couldn't copy the image: ${errorMessage(cause)}`),
  );
}
