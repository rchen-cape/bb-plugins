import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SketchIcon } from "./components/icons";
import { SketchPage } from "./components/SketchPage";
import { SKETCH_ICON, SKETCH_PANEL } from "./lib/sketch";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: SKETCH_ICON, component: SketchIcon });
  app.slots.navPanel({
    id: SKETCH_PANEL,
    title: "Sketch",
    icon: SKETCH_ICON,
    path: SKETCH_PANEL,
    component: SketchPage,
  });
});
