import { useMemo, useState } from "react";
import {
  selectionStyle,
  selectionStyleFields,
  styleFieldsFor,
  type StyleField,
  type StylePatch,
  type StyleValue,
  type StyleValues,
} from "../lib/actions.js";
import type { SketchStyle } from "../lib/elements.js";
import { BACKGROUND_PICKS, STROKE_PICKS } from "../lib/sketch.js";
import { cn } from "../lib/utils";
import { Island } from "./bits";
import { useController, useEditor, useEditorUi, useTheme } from "./editor-context";
import { BackwardIcon, DuplicateIcon, ForwardIcon, SendIcon, StyleIcon, ToBackIcon, ToFrontIcon, TrashIcon } from "./icons";
import { LAYER_KEYS, mod } from "./menu";
import { deleteSelected, duplicateSelected, reorderSelected } from "./scene-actions";
import { ColorPicks, OpacitySlider, Picks, Row } from "./StylePicks";
import {
  arrowheadOptions,
  EDGE_OPTIONS,
  FILL_OPTIONS,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_OPTIONS,
  ROUGHNESS_OPTIONS,
  STROKE_STYLE_OPTIONS,
  STROKE_WIDTH_OPTIONS,
  TEXT_ALIGN_OPTIONS,
} from "./style-options";
import { ToolButton } from "./ToolButton";
import { isDrawingTool, toolElementType } from "./tools";
import { useIsCompactViewport } from "./ui/hooks/use-compact-viewport";

const START_HEADS = arrowheadOptions("start");
const END_HEADS = arrowheadOptions("end");

function fixed<K extends StyleField>(style: SketchStyle, field: K): StyleValue<K> {
  return { mixed: false, value: style[field] };
}

function toolValues(style: SketchStyle): StyleValues {
  return {
    strokeColor: fixed(style, "strokeColor"),
    backgroundColor: fixed(style, "backgroundColor"),
    fillStyle: fixed(style, "fillStyle"),
    strokeWidth: fixed(style, "strokeWidth"),
    strokeStyle: fixed(style, "strokeStyle"),
    roughness: fixed(style, "roughness"),
    edges: fixed(style, "edges"),
    startArrowhead: fixed(style, "startArrowhead"),
    endArrowhead: fixed(style, "endArrowhead"),
    fontSize: fixed(style, "fontSize"),
    fontFamily: fixed(style, "fontFamily"),
    textAlign: fixed(style, "textAlign"),
    opacity: fixed(style, "opacity"),
  };
}

function picked<K extends StyleField>(values: StyleValues, field: K): SketchStyle[K] | undefined {
  const value: StyleValue<K> | undefined = values[field];
  return value === undefined || value.mixed ? undefined : value.value;
}

function usePanelModel() {
  const elements = useEditor((state) => state.elements);
  const selectedIds = useEditor((state) => state.selectedIds);
  const tool = useEditor((state) => state.tool);
  const style = useEditor((state) => state.style);
  const editing = useEditor((state) => state.editing !== null);
  const hasSelection = selectedIds.size > 0;
  const fields = useMemo<readonly StyleField[]>(() => {
    if (hasSelection) return selectionStyleFields(elements, selectedIds);
    return isDrawingTool(tool) ? styleFieldsFor(toolElementType(tool)) : [];
  }, [hasSelection, elements, selectedIds, tool]);
  const values = useMemo(() => (hasSelection ? selectionStyle(elements, selectedIds) : toolValues(style)), [hasSelection, elements, selectedIds, style]);
  const visible = !editing && (hasSelection || isDrawingTool(tool));
  return { fields, values, hasSelection, visible };
}

function StyleRows({ fields, values }: { fields: readonly StyleField[]; values: StyleValues }) {
  const controller = useController();
  const theme = useTheme();
  const has = (field: StyleField) => fields.includes(field);
  const set = (patch: StylePatch, transient = false) => controller.setStyle(patch, transient);
  const commit = () => controller.commit();
  return (
    <>
      {has("strokeColor") ? (
        <ColorPicks label="Stroke" picks={STROKE_PICKS} value={picked(values, "strokeColor")} theme={theme} custom onPick={(strokeColor, transient) => set({ strokeColor }, transient)} onCommit={commit} />
      ) : null}
      {has("backgroundColor") ? (
        <ColorPicks label="Background" picks={BACKGROUND_PICKS} value={picked(values, "backgroundColor")} theme={theme} custom={false} onPick={(backgroundColor) => set({ backgroundColor })} onCommit={commit} />
      ) : null}
      {has("fillStyle") ? <Picks label="Fill" options={FILL_OPTIONS} value={picked(values, "fillStyle")} onPick={(fillStyle) => set({ fillStyle })} /> : null}
      {has("strokeWidth") ? <Picks label="Stroke width" options={STROKE_WIDTH_OPTIONS} value={picked(values, "strokeWidth")} onPick={(strokeWidth) => set({ strokeWidth })} /> : null}
      {has("strokeStyle") ? <Picks label="Stroke style" options={STROKE_STYLE_OPTIONS} value={picked(values, "strokeStyle")} onPick={(strokeStyle) => set({ strokeStyle })} /> : null}
      {has("roughness") ? <Picks label="Sloppiness" options={ROUGHNESS_OPTIONS} value={picked(values, "roughness")} onPick={(roughness) => set({ roughness })} /> : null}
      {has("edges") ? <Picks label="Edges" options={EDGE_OPTIONS} value={picked(values, "edges")} onPick={(edges) => set({ edges })} /> : null}
      {has("startArrowhead") ? <Picks label="Start arrowhead" options={START_HEADS} value={picked(values, "startArrowhead")} onPick={(startArrowhead) => set({ startArrowhead })} /> : null}
      {has("endArrowhead") ? <Picks label="End arrowhead" options={END_HEADS} value={picked(values, "endArrowhead")} onPick={(endArrowhead) => set({ endArrowhead })} /> : null}
      {has("fontSize") ? <Picks label="Font size" options={FONT_SIZE_OPTIONS} value={picked(values, "fontSize")} onPick={(fontSize) => set({ fontSize })} /> : null}
      {has("fontFamily") ? <Picks label="Font" options={FONT_FAMILY_OPTIONS} value={picked(values, "fontFamily")} onPick={(fontFamily) => set({ fontFamily })} /> : null}
      {has("textAlign") ? <Picks label="Text align" options={TEXT_ALIGN_OPTIONS} value={picked(values, "textAlign")} onPick={(textAlign) => set({ textAlign })} /> : null}
      {has("opacity") ? <OpacitySlider value={picked(values, "opacity")} onInput={(opacity) => set({ opacity }, true)} onCommit={commit} /> : null}
    </>
  );
}

function SelectionActions() {
  const controller = useController();
  const ui = useEditorUi();
  return (
    <>
      <Row label="Layers">
        <ToolButton side="right" label="Send to back" tooltip={`Send to back · ${LAYER_KEYS.back}`} onClick={() => reorderSelected(controller, "back")}>
          <ToBackIcon />
        </ToolButton>
        <ToolButton side="right" label="Send backward" tooltip={`Send backward · ${LAYER_KEYS.backward}`} onClick={() => reorderSelected(controller, "backward")}>
          <BackwardIcon />
        </ToolButton>
        <ToolButton side="right" label="Bring forward" tooltip={`Bring forward · ${LAYER_KEYS.forward}`} onClick={() => reorderSelected(controller, "forward")}>
          <ForwardIcon />
        </ToolButton>
        <ToolButton side="right" label="Bring to front" tooltip={`Bring to front · ${LAYER_KEYS.front}`} onClick={() => reorderSelected(controller, "front")}>
          <ToFrontIcon />
        </ToolButton>
      </Row>
      <Row label="Actions">
        <ToolButton side="right" label="Duplicate" tooltip={`Duplicate · ${mod("D")}`} onClick={() => duplicateSelected(controller)}>
          <DuplicateIcon />
        </ToolButton>
        <ToolButton side="right" label="Delete" tooltip="Delete · ⌫" onClick={() => deleteSelected(controller)}>
          <TrashIcon />
        </ToolButton>
        <ToolButton side="right" label="Send selection to Wiki" tooltip={`Send to Wiki · ${mod("S", true)}`} onClick={ui.send}>
          <SendIcon />
        </ToolButton>
      </Row>
    </>
  );
}

function PanelBody({ fields, values, hasSelection }: { fields: readonly StyleField[]; values: StyleValues; hasSelection: boolean }) {
  return (
    <Island role="region" aria-label="Style" className="pointer-events-auto grid max-h-full w-56 gap-3 overflow-y-auto p-3 [scrollbar-gutter:stable]">
      <StyleRows fields={fields} values={values} />
      {hasSelection ? <SelectionActions /> : null}
    </Island>
  );
}

export function PropertiesPanel() {
  const { fields, values, hasSelection, visible } = usePanelModel();
  const compact = useIsCompactViewport();
  const [open, setOpen] = useState(false);
  if (!visible) return null;
  if (!compact) return <PanelBody fields={fields} values={values} hasSelection={hasSelection} />;
  return (
    <div className="pointer-events-auto flex max-h-full min-h-0 flex-col items-start gap-2">
      <Island className="p-1">
        <ToolButton side="right" label={open ? "Hide style" : "Show style"} pressed={open} onClick={() => setOpen((current) => !current)}>
          <StyleIcon />
        </ToolButton>
      </Island>
      <div className={cn("min-h-0", open ? "flex" : "hidden")}>
        <PanelBody fields={fields} values={values} hasSelection={hasSelection} />
      </div>
    </div>
  );
}
