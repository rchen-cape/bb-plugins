import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { installDomPolyfills } from "./lib/live-preview/test-dom";

if (typeof window !== "undefined") {
  installTestPluginRuntime();
  installDomPolyfills();
}
