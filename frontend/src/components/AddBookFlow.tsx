import { Toast } from 'primereact/toast';
import { useMemo, useRef, useSyncExternalStore } from 'react';

import { useAgentAnchor } from '../agent-ui';
import { useLibrary } from '../hooks/useLibrary';
import { useSettings } from '../settings/SettingsContext';
import type { Book, BookInput, VolumeSearchResult } from '../types';
import { BookFormDialog } from './BookFormDialog';
import { SearchDialog } from './SearchDialog';
import './AddBookFlow.css';

/**
 * Adding a book is the app's main action, so it lives at the shell level (mounted once in
 * App), not inside the Library tab: a round "+" button floats above the microphone on every
 * tab and opens the Google Books search. "Add manually" is inside that dialog.
 *
 * The open/closed state sits in a tiny module store so other places (the Library's
 * `library.dialogs` anchor, tests) can read and close it without prop drilling.
 */
export type AddBookState =
  | { view: 'closed' }
  | { view: 'search'; query?: string }
  | { view: 'form'; initial?: Partial<BookInput> };

let state: AddBookState = { view: 'closed' };
const listeners = new Set<() => void>();

function setState(next: AddBookState) {
  state = next;
  listeners.forEach((l) => l());
}

export const addBookStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Open the Google Books search; a query is typed AND searched at once. */
  openSearch: (query?: string) => setState({ view: 'search', query }),
  openManual: (initial?: Partial<BookInput>) => setState({ view: 'form', initial }),
  close: () => setState({ view: 'closed' }),
};

export function useAddBookState(): AddBookState {
  return useSyncExternalStore(addBookStore.subscribe, addBookStore.get, addBookStore.get);
}

export function AddBookFlow() {
  const current = useAddBookState();
  const { books, add, upsert } = useLibrary();
  const { settings } = useSettings();
  const toast = useRef<Toast>(null);

  const existingVolumeIds = useMemo(
    () => new Set(books.map((b) => b.google_volume_id).filter((v): v is string => v != null)),
    [books],
  );

  useAgentAnchor({
    id: 'library.addBook',
    kind: 'button',
    label: 'Add a book',
    description:
      'Open the add-book flow (available on every tab). Invoke with action "search" (args ' +
      '{ query } — opens the Google-search dialog, types the query AND runs the search, so ' +
      'results show at once; nothing else to click), action "manual" (args { prefill? } — the ' +
      'manual form) or action "close".',
    actions: ['search', 'manual', 'close'],
    getState: () => current.view,
    invoke: (action, args) => {
      if (action === 'close') {
        addBookStore.close();
      } else if (action === 'manual') {
        addBookStore.openManual(args?.prefill as Partial<BookInput> | undefined);
      } else {
        addBookStore.openSearch(typeof args?.query === 'string' ? args.query : undefined);
      }
    },
  });

  const handleAdd = async (volume: VolumeSearchResult) => {
    try {
      const book = await add(volume);
      toast.current?.show({ severity: 'success', summary: 'Added', detail: book.title });
    } catch (err) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: err instanceof Error ? err.message : 'Could not add book',
      });
    }
  };

  const handleSaved = (book: Book) => {
    upsert(book);
    addBookStore.close();
    toast.current?.show({ severity: 'success', summary: 'Added', detail: book.title });
  };

  const fabClass = [
    'add-book-fab',
    settings.showVoiceButton ? '' : 'no-mic',
    settings.showChatButton ? '' : 'no-chat',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <Toast ref={toast} position="bottom-right" />
      <button
        type="button"
        className={fabClass}
        aria-label="Add book"
        title="Add book"
        data-agent-anchor="library.addBook"
        onClick={() => addBookStore.openSearch()}
      >
        <i className="pi pi-plus" aria-hidden="true" />
      </button>

      <SearchDialog
        visible={current.view === 'search'}
        // "Add manually" switches to the form and THEN calls onHide: only close if the
        // search is still the open view, or the form would be closed straight away.
        onHide={() => {
          if (addBookStore.get().view === 'search') addBookStore.close();
        }}
        onAdd={handleAdd}
        existingVolumeIds={existingVolumeIds}
        onAddManually={(prefill) => addBookStore.openManual(prefill)}
        initialQuery={current.view === 'search' ? current.query : undefined}
      />

      {current.view === 'form' && (
        <BookFormDialog
          visible
          mode="create"
          initial={current.initial}
          onHide={addBookStore.close}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
