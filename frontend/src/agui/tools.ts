/**
 * Browser tools: functions the assistant can call, but that run here in the page.
 *
 * Each tool has the AG-UI definition the agent sees (name, description and a JSON
 * Schema for its arguments) and a `run` function that drives the app. The tools are
 * generic: controls declare themselves as anchors in a runtime registry
 * (`../agent-ui/`), and these tools read and drive that registry. A new tab or
 * control is a `useAgentAnchor` call in that component; nothing here changes.
 *
 * Data (books, series, stats) is NOT here: the agent has its own server-side tools
 * for that (`app/agent/tools.py`).
 */
import type { Context, Tool } from '@ag-ui/core';

import { emitAgentFx } from '../agent-ui/agentFx';
import {
  describeUi,
  getAnchorState,
  invokeAnchor,
  navigate as registryNavigate,
  setAnchor,
} from '../agent-ui';
import { describeAction } from './labels';

type Args = Record<string, unknown>;

interface BrowserTool extends Tool {
  run: (args: Args) => unknown | Promise<unknown>;
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

/**
 * A registry result `{ ok: false, error, valid? }` becomes a tool error the agent can
 * read. The whole result goes along, so the agent sees the valid ids / values too.
 */
function unwrap<T extends { ok: boolean }>(result: T): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}

/**
 * Wait (up to 2 s) until `tab` is the active, mounted tab. Some tabs load lazily, and
 * the next run reads the screen: answering too early shows the old tab, and the
 * agent repeats the navigation.
 */
async function tabMounted(tab: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ui = describeUi();
    if (ui.activeTab === tab && ui.tabs.find((t) => t.id === tab)?.mounted) return;
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const TOOLS: BrowserTool[] = [
  {
    name: 'describe_ui',
    description:
      'Read the whole UI as a schema: every tab and its controls (anchors) with id, kind, ' +
      'label, current value, allowed options and actions; lists expose their items. The ' +
      'current schema is already in <client_context>, so call this only after navigate, ' +
      'when the new tab has mounted.',
    parameters: object({}),
    run: () => describeUi(),
  },
  {
    name: 'get_state',
    description: "Read one control's current value by its anchor id.",
    parameters: object({ id: { type: 'string' } }, ['id']),
    run: (args) => unwrap(getAnchorState(requireString(args, 'id'))),
  },
  {
    name: 'set',
    description:
      'Set a value control (text-input, search, select, toggle, multi-select) by its anchor ' +
      'id. value is a string for text/search, true/false for a toggle, an option value for a ' +
      'select, or an array of option values for a multi-select.',
    parameters: object(
      {
        id: { type: 'string' },
        value: { type: ['string', 'number', 'boolean', 'array', 'null'], items: { type: 'string' } },
      },
      ['id'],
    ),
    run: async (args) => {
      const id = requireString(args, 'id');
      const result = unwrap(await setAnchor(id, args.value));
      emitAgentFx({ kind: 'set', target: id, label: describeAction('set', args) });
      return result;
    },
  },
  {
    name: 'invoke',
    description:
      'Run an action on a button, a dialog (open/close) or a list item by its anchor id. ' +
      'action names the sub-action when there are several; args carries its parameters ' +
      '(e.g. { "id": 42 } to open a book).',
    parameters: object(
      {
        id: { type: 'string' },
        action: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
      },
      ['id'],
    ),
    run: async (args) => {
      const id = requireString(args, 'id');
      const action = typeof args.action === 'string' ? args.action : undefined;
      const params = args.args && typeof args.args === 'object' ? (args.args as Args) : undefined;
      const result = unwrap(await invokeAnchor(id, action, params));
      const isNav = id === 'nav.tab' && action === 'navigate';
      if (isNav) await tabMounted(String(params?.tab ?? ''));
      emitAgentFx({
        kind: isNav ? 'navigate' : 'invoke',
        target: isNav ? String(params?.tab ?? '') : id,
        label: describeAction('invoke', args),
      });
      return result;
    },
  },
  {
    name: 'navigate',
    description: 'Switch the active tab (a tab id from <client_context>, e.g. "library", "stats").',
    parameters: object({ tab: { type: 'string' } }, ['tab']),
    run: async (args) => {
      const tab = requireString(args, 'tab');
      const result = unwrap(await registryNavigate(tab));
      await tabMounted(tab);
      emitAgentFx({ kind: 'navigate', target: tab, label: describeAction('navigate', args) });
      return result;
    },
  },
];

/** The tool definitions sent to the agent (without the `run` functions). */
export const TOOL_DEFINITIONS: Tool[] = TOOLS.map(({ run: _run, ...definition }) => definition);

/** True when `name` is one of these browser tools (not a server-side data tool). */
export function isBrowserTool(name: string): boolean {
  return TOOLS.some((t) => t.name === name);
}

/** Run one tool call from the agent. A failure goes back to the agent as an error. */
export async function runTool(
  name: string,
  argsJson: string,
): Promise<{ content: string; error?: string }> {
  try {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool "${name}"`);
    const result = await tool.run(JSON.parse(argsJson || '{}') as Args);
    return { content: typeof result === 'string' ? result : JSON.stringify(result) };
  } catch (err) {
    return { content: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** What the user sees right now, sent to the agent with every run as AG-UI context. */
export function describeScreen(): Context[] {
  return [{ description: 'Current UI (tabs, controls, values)', value: JSON.stringify(describeUi()) }];
}
