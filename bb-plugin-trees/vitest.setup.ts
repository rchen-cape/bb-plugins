import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

if (typeof window !== "undefined") installTestPluginRuntime();
