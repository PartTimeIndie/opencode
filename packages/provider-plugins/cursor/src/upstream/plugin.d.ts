import type { Hooks, PluginInput } from "@opencode-ai/plugin";
export { modelInfoToConfig, modelsToConfig, thinkingSuffixBaseNames } from "./model-config.js";
export declare function loadClassicTools(): Promise<{
    webSearch: any;
    imageSave: any;
}>;
export declare function CursorPlugin(input: PluginInput): Promise<Hooks>;
