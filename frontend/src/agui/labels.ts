/**
 * Short, human-readable labels for the UI agent's action cards, shown in the
 * chat when the browser executes a tool. Pure functions — unit-testable.
 *
 * The agent's tools are now generic (registry-driven): `describe_ui`, `get_state`,
 * `set`, `invoke`, `navigate` and `find_books`. The label is derived from the
 * tool name and the anchor id / value in its arguments, so it still reads well
 * for any current or future control without a per-action case.
 */

/** Turn a dotted anchor id into a short readable phrase, e.g. `library.search` → "library search". */
function readableId(id: unknown): string {
  if (typeof id !== 'string' || !id) {
    return '';
  }
  return id.replace(/[.]/g, ' ');
}

/** A compact rendering of a set value for the card. */
function readableValue(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}

/** A short "what the agent did" label for a tool name + its arguments. */
export function describeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'describe_ui':
      return 'Read the interface';
    case 'get_state':
      return `Read ${readableId(args.id)}`.trim();
    case 'set': {
      const target = readableId(args.id);
      const value = readableValue(args.value);
      if (target && value) {
        return `Set ${target} → ${value}`;
      }
      return target ? `Set ${target}` : 'Set a control';
    }
    case 'invoke': {
      const target = readableId(args.id);
      const action = typeof args.action === 'string' && args.action ? args.action : '';
      if (target && action) {
        return `${action} ${target}`;
      }
      return target ? `Invoke ${target}` : 'Invoke a control';
    }
    case 'navigate':
      return `Go to ${readableValue(args.tab) || 'a tab'}`;
    case 'series_releases':
      return args.refresh === true
        ? `Checking new volumes "${String(args.name ?? '')}"…`
        : `Series "${String(args.name ?? '')}"`;
    case 'find_books':
      return `Find books "${String(args.query ?? '')}"`;
    case 'ask_librarian':
      return 'Asking the librarian…';
    default:
      return name;
  }
}
