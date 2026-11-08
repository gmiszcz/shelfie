import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BookDetailDialog } from './BookDetailDialog';
import { makeBook } from './testHelpers';
import { SettingsProvider } from '../settings/SettingsContext';
import {
  CARD_FIELDS,
  DETAIL_SECTIONS,
  type DetailSection,
  type Settings,
} from '../settings/settingsTypes';

const STORAGE_KEY = 'shelfie.settings.v1';

function seedSettings(partial: {
  detailSections?: Partial<Record<DetailSection, boolean>>;
  showAllDetails?: boolean;
}): void {
  const all = <K extends string>(keys: K[]): Record<K, boolean> =>
    Object.fromEntries(keys.map((k) => [k, true])) as Record<K, boolean>;
  const settings: Settings = {
    cardFields: all(CARD_FIELDS),
    detailSections: { ...all(DETAIL_SECTIONS), ...(partial.detailSections ?? {}) },
    showAllDetails: partial.showAllDetails ?? true,
    showVoiceButton: true,
    showChatButton: true,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function renderDialog() {
  return render(
    <SettingsProvider>
      <BookDetailDialog
        book={makeBook()}
        onHide={() => {}}
        onStatus={() => {}}
        onStars={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />
    </SettingsProvider>,
  );
}

/** A DOM probe for each detail section: a substring that is only present when the section renders. */
const SECTION_PROBES: Record<DetailSection, (root: HTMLElement) => boolean> = {
  status: (r) => within(r).queryByText('Status:') != null,
  rating: (r) => within(r).queryByText('Rating:') != null,
  score: (r) => within(r).queryByText(/^Score /) != null,
  readingDates: (r) => within(r).queryByText(/Started /) != null,
  pages: (r) => within(r).queryByText(/412 pages/) != null,
  shelves: (r) => within(r).queryByText('Shelves:') != null,
  description: (r) => within(r).queryByText('Description') != null,
  series: (r) => within(r).queryByText('Series') != null,
  tags: (r) => within(r).queryByText('Tags') != null,
  insights: (r) => within(r).queryByText('Insights') != null,
  notes: (r) => within(r).queryByText('Notes', { selector: 'h4' }) != null,
  purchase: (r) => within(r).queryByText('Purchase') != null,
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('BookDetailDialog — settings drive section visibility', () => {
  beforeEach(() => localStorage.clear());

  it('shows every section when all toggles are on and showAllDetails is true', () => {
    seedSettings({ showAllDetails: true });
    renderDialog();
    const dialog = screen.getByRole('dialog');
    for (const section of DETAIL_SECTIONS) {
      expect(SECTION_PROBES[section](dialog), `${section} should be visible`).toBe(true);
    }
  });

  // One case per section: turning its toggle off hides exactly that section.
  for (const section of DETAIL_SECTIONS) {
    it(`hides the "${section}" section when its toggle is off`, () => {
      seedSettings({ showAllDetails: true, detailSections: { [section]: false } });
      renderDialog();
      const dialog = screen.getByRole('dialog');
      expect(SECTION_PROBES[section](dialog), `${section} should be hidden`).toBe(false);
    });
  }
});

describe('BookDetailDialog — showAllDetails default', () => {
  beforeEach(() => localStorage.clear());

  it('hides extended sections by default when showAllDetails is false', () => {
    seedSettings({ showAllDetails: false });
    renderDialog();
    const dialog = screen.getByRole('dialog');
    // Always-visible sections still show.
    expect(SECTION_PROBES.description(dialog)).toBe(true);
    // Extended sections are collapsed behind the default-off "Show details".
    expect(SECTION_PROBES.insights(dialog)).toBe(false);
    expect(SECTION_PROBES.notes(dialog)).toBe(false);
    expect(SECTION_PROBES.purchase(dialog)).toBe(false);
    // The in-dialog toggle is present and off.
    const toggle = within(dialog).getByText('Show details');
    expect(toggle).toBeTruthy();
  });

  it('reveals extended sections by default when showAllDetails is true', () => {
    seedSettings({ showAllDetails: true });
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(SECTION_PROBES.insights(dialog)).toBe(true);
    expect(SECTION_PROBES.notes(dialog)).toBe(true);
    expect(SECTION_PROBES.purchase(dialog)).toBe(true);
  });
});
