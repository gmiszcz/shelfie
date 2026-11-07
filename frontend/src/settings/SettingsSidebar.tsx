import { Button } from 'primereact/button';
import { Checkbox } from 'primereact/checkbox';
import { InputSwitch } from 'primereact/inputswitch';
import { Sidebar } from 'primereact/sidebar';
import { useEffect, useState } from 'react';

import { useSettings } from './SettingsContext';
import {
  CARD_FIELDS,
  CARD_FIELD_LABELS,
  DETAIL_SECTIONS,
  DETAIL_SECTION_LABELS,
} from './settingsTypes';

interface Props {
  visible: boolean;
  onHide: () => void;
}

/** Which screen of the drawer is showing: the menu, or one group's options. */
type View = 'menu' | 'cards' | 'detail';

/**
 * Settings drawer as a two-level menu (like phone settings):
 * - the menu lists "Library cards" and "Book detail" (with how many items are on),
 *   plus the on/off switches;
 * - tapping a group opens its checkbox list, with a back arrow to the menu.
 */
export function SettingsSidebar({ visible, onHide }: Props) {
  const {
    settings,
    toggleCardField,
    toggleDetailSection,
    setShowAllDetails,
    setShowVoiceButton,
    reset,
  } = useSettings();
  const [view, setView] = useState<View>('menu');

  // Always reopen on the menu.
  useEffect(() => {
    if (visible) setView('menu');
  }, [visible]);

  const cardsOn = CARD_FIELDS.filter((f) => settings.cardFields[f]).length;
  const detailOn = DETAIL_SECTIONS.filter((s) => settings.detailSections[s]).length;

  const header =
    view === 'menu' ? (
      <span className="settings-title">
        <i className="pi pi-cog" aria-hidden="true" /> Settings
      </span>
    ) : (
      <button type="button" className="settings-back" onClick={() => setView('menu')}>
        <i className="pi pi-chevron-left" aria-hidden="true" />
        {view === 'cards' ? 'Library cards' : 'Book detail'}
      </button>
    );

  return (
    <Sidebar
      visible={visible}
      position="right"
      onHide={onHide}
      className="settings-sidebar"
      header={header}
    >
      {view === 'menu' && (
        <div className="settings-body">
          <nav className="settings-menu" aria-label="Settings groups">
            <button type="button" className="settings-menu-row" onClick={() => setView('cards')}>
              <i className="pi pi-th-large settings-menu-icon" aria-hidden="true" />
              <span className="settings-menu-text">
                <span className="settings-menu-label">Library cards</span>
                <span className="settings-menu-sub">
                  {cardsOn} of {CARD_FIELDS.length} fields shown
                </span>
              </span>
              <i className="pi pi-chevron-right settings-menu-chevron" aria-hidden="true" />
            </button>
            <button type="button" className="settings-menu-row" onClick={() => setView('detail')}>
              <i className="pi pi-book settings-menu-icon" aria-hidden="true" />
              <span className="settings-menu-text">
                <span className="settings-menu-label">Book detail</span>
                <span className="settings-menu-sub">
                  {detailOn} of {DETAIL_SECTIONS.length} sections shown
                </span>
              </span>
              <i className="pi pi-chevron-right settings-menu-chevron" aria-hidden="true" />
            </button>
          </nav>

          <section className="settings-menu">
            <label className="settings-menu-row settings-switch-row">
              <span className="settings-menu-text">
                <span className="settings-menu-label">Show all details</span>
                <span className="settings-menu-sub">Expand insights, notes, purchase…</span>
              </span>
              <InputSwitch
                checked={settings.showAllDetails}
                onChange={(e) => setShowAllDetails(!!e.value)}
              />
            </label>
            <label className="settings-menu-row settings-switch-row">
              <span className="settings-menu-text">
                <span className="settings-menu-label">Voice button</span>
                <span className="settings-menu-sub">Microphone on the main view</span>
              </span>
              <InputSwitch
                checked={settings.showVoiceButton}
                onChange={(e) => setShowVoiceButton(!!e.value)}
              />
            </label>
          </section>

          <Button
            label="Reset to defaults"
            icon="pi pi-refresh"
            text
            onClick={reset}
            className="settings-reset"
          />
        </div>
      )}

      {view === 'cards' && (
        <div className="settings-body">
          <p className="settings-hint">Which fields appear on each book card.</p>
          <div className="settings-options">
            {CARD_FIELDS.map((field) => (
              <label key={field} className="settings-option">
                <Checkbox
                  inputId={`card-${field}`}
                  checked={settings.cardFields[field]}
                  onChange={() => toggleCardField(field)}
                />
                <span>{CARD_FIELD_LABELS[field]}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {view === 'detail' && (
        <div className="settings-body">
          <p className="settings-hint">Which sections appear in the book detail view.</p>
          <div className="settings-options">
            {DETAIL_SECTIONS.map((section) => (
              <label key={section} className="settings-option">
                <Checkbox
                  inputId={`detail-${section}`}
                  checked={settings.detailSections[section]}
                  onChange={() => toggleDetailSection(section)}
                />
                <span>{DETAIL_SECTION_LABELS[section]}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </Sidebar>
  );
}
