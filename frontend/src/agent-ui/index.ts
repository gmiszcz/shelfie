/**
 * The universal agent-UI registry.
 *
 * Controls declare themselves with {@link useAgentAnchor}; the browser-side agent
 * discovers and drives them through {@link describeUi} / {@link getAnchorState} /
 * {@link setAnchor} / {@link invokeAnchor} / {@link navigate}. Adding a tab or a
 * control needs NO agent-side code — the schema is built at runtime from the live
 * registry.
 */

export { useAgentAnchor } from './useAgentAnchor';
export {
  describeUi,
  getAnchorState,
  setAnchor,
  invokeAnchor,
  navigate,
  registerAnchor,
  onRegistryChange,
  setStaticTabs,
  setActiveTab,
  getActiveTab,
  getAnchor,
  anchorIds,
  NAV_TAB_ID,
  LIST_ITEM_CAP,
  OPTION_CAP,
  _resetRegistry,
} from './registry';
export type { ActResult, StaticTab } from './registry';
export type {
  AnchorConfig,
  AnchorDescription,
  AnchorKind,
  AnchorListItem,
  AnchorOption,
  TabDescription,
  UiSchema,
} from './types';
