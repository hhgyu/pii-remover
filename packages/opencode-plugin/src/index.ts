export { PiiRemoverPlugin as default } from "./hooks.js";
export {
  createPluginHooks,
  configurePiiRemoverPlugin,
  DEFAULT_SKIP_FIELDS,
  MIN_MASK_LENGTH,
  maskTextFields,
  maskTextFieldsStrict,
  restoreTextFields,
  loadPluginConfig,
  DEFAULT_DISPLAY_TOOL_NAMES,
  DEFAULT_DISPLAY_TOOL_SUFFIXES,
  isDisplayTool,
  resolveDisplayToolConfig,
} from "./hooks.js";
export type {
  MaskOptions,
  PiiRemoverConfig,
  PiiRemoverPluginOptions,
  PluginMode,
  DisplayToolConfig,
} from "./hooks.js";
