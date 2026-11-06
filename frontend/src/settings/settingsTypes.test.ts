import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, mergeSettings } from './settingsTypes';

describe('mergeSettings', () => {
  it('returns defaults for non-object input', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults every card field and detail section to ON', () => {
    expect(Object.values(DEFAULT_SETTINGS.cardFields).every(Boolean)).toBe(true);
    expect(Object.values(DEFAULT_SETTINGS.detailSections).every(Boolean)).toBe(true);
    expect(DEFAULT_SETTINGS.showAllDetails).toBe(false);
  });

  it('overlays stored values onto defaults (new keys stay ON)', () => {
    const merged = mergeSettings({
      cardFields: { author: false },
      detailSections: { notes: false },
      showAllDetails: true,
    });
    expect(merged.cardFields.author).toBe(false);
    // a key not present in storage keeps the default (true)
    expect(merged.cardFields.year).toBe(true);
    expect(merged.detailSections.notes).toBe(false);
    expect(merged.detailSections.description).toBe(true);
    expect(merged.showAllDetails).toBe(true);
  });

  it('ignores a non-boolean showAllDetails', () => {
    const merged = mergeSettings({ showAllDetails: 'yes' as unknown as boolean });
    expect(merged.showAllDetails).toBe(false);
  });
});
