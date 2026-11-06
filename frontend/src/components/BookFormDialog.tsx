import { Button } from 'primereact/button';
import { Calendar } from 'primereact/calendar';
import { Chips } from 'primereact/chips';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { InputSwitch } from 'primereact/inputswitch';
import { InputText } from 'primereact/inputtext';
import { InputTextarea } from 'primereact/inputtextarea';
import { ProgressSpinner } from 'primereact/progressspinner';
import { TabPanel, TabView } from 'primereact/tabview';
import { useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '../services/api';
import type { Book, BookInput, BookPatch, ReadingStatus } from '../types';
import { STATUS_LABELS } from '../types';
import {
  type FormState,
  emptyForm,
  fromBook,
  toInput,
  validate,
} from '../bookForm';
import { CoverPicker } from './CoverPicker';
import './BookFormDialog.css';

interface Props {
  visible: boolean;
  mode: 'create' | 'edit';
  bookId?: number;
  initial?: Partial<BookInput>;
  onHide: () => void;
  onSaved: (book: Book) => void;
}

const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as ReadingStatus[]).map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

/** A labelled form row; shows an inline error message when present. */
function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bf-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error && <small className="bf-error">{error}</small>}
    </div>
  );
}

export function BookFormDialog({ visible, mode, bookId, initial, onHide, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  // (Re)initialise the form each time the dialog is opened.
  useEffect(() => {
    if (!visible) {
      return;
    }
    setErrors({});
    setApiError(null);
    setActiveTab(0);
    if (mode === 'edit' && bookId != null) {
      setLoading(true);
      setForm(emptyForm());
      api
        .getBook(bookId)
        .then((book) => setForm(fromBook(book)))
        .catch((err) =>
          setApiError(err instanceof Error ? err.message : 'Could not load this book.'),
        )
        .finally(() => setLoading(false));
    } else {
      setForm(fromBook(initial));
    }
    // initial is intentionally only read on (re)open to avoid clobbering edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode, bookId]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const headerTitle = mode === 'create' ? 'Add a book' : 'Edit book';

  const save = async () => {
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setActiveTab(1); // Basics tab holds the title
      return;
    }
    setSaving(true);
    setApiError(null);
    try {
      const payload = toInput(form);
      let book: Book;
      if (mode === 'edit' && bookId != null) {
        const patch: BookPatch = { ...payload };
        delete (patch as { metadata_source?: unknown }).metadata_source;
        book = await api.updateBook(bookId, patch);
      } else {
        book = await api.createBook(payload);
      }
      onSaved(book);
    } catch (err) {
      if (err instanceof ApiError) {
        setApiError(err.message);
      } else {
        setApiError(err instanceof Error ? err.message : 'Save failed.');
      }
    } finally {
      setSaving(false);
    }
  };

  const footer = useMemo(
    () => (
      <div className="flex justify-content-end gap-2">
        <Button label="Cancel" icon="pi pi-times" text onClick={onHide} disabled={saving} />
        <Button
          label={mode === 'create' ? 'Add book' : 'Save changes'}
          icon="pi pi-check"
          onClick={() => void save()}
          loading={saving}
          disabled={loading}
        />
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving, loading, mode, form],
  );

  return (
    <Dialog
      header={headerTitle}
      visible={visible}
      onHide={onHide}
      footer={footer}
      style={{ width: 'min(820px, 96vw)' }}
      dismissableMask={!saving}
      closable={!saving}
    >
      {loading ? (
        <div className="flex justify-content-center p-5">
          <ProgressSpinner />
        </div>
      ) : (
        <>
          {apiError && <div className="bf-api-error">{apiError}</div>}

          <TabView
            activeIndex={activeTab}
            onTabChange={(e) => setActiveTab(e.index)}
            scrollable
          >
            <TabPanel header="Cover">
              <CoverPicker
                value={form.cover_url}
                onChange={(url) => set('cover_url', url)}
                title={form.title}
                authors={form.authors}
                isbn={form.isbn_13 || form.isbn_10}
              />
            </TabPanel>

            <TabPanel header="Basics">
              <div className="bf-grid">
                <Field label="Title *" htmlFor="bf-title" error={errors.title}>
                  <InputText
                    id="bf-title"
                    value={form.title}
                    onChange={(e) => set('title', e.target.value)}
                    className={errors.title ? 'p-invalid' : undefined}
                  />
                </Field>
                <Field label="Subtitle" htmlFor="bf-subtitle">
                  <InputText
                    id="bf-subtitle"
                    value={form.subtitle}
                    onChange={(e) => set('subtitle', e.target.value)}
                  />
                </Field>
                <Field label="Authors">
                  <Chips
                    value={form.authors}
                    onChange={(e) => set('authors', e.value ?? [])}
                    separator=","
                    placeholder="Add an author and press Enter"
                  />
                </Field>
                <Field label="Translators">
                  <Chips
                    value={form.translators}
                    onChange={(e) => set('translators', e.value ?? [])}
                    separator=","
                  />
                </Field>
                <Field label="Publisher" htmlFor="bf-publisher">
                  <InputText
                    id="bf-publisher"
                    value={form.publisher}
                    onChange={(e) => set('publisher', e.target.value)}
                  />
                </Field>
                <Field label="Published date" htmlFor="bf-pubdate">
                  <InputText
                    id="bf-pubdate"
                    value={form.published_date}
                    placeholder="YYYY or YYYY-MM-DD"
                    onChange={(e) => set('published_date', e.target.value)}
                  />
                </Field>
                <Field label="Page count" error={errors.page_count}>
                  <InputNumber
                    value={form.page_count}
                    onValueChange={(e) => set('page_count', e.value ?? null)}
                    min={0}
                    useGrouping={false}
                    className={errors.page_count ? 'p-invalid' : undefined}
                  />
                </Field>
                <Field label="Language" htmlFor="bf-lang">
                  <InputText
                    id="bf-lang"
                    value={form.language}
                    placeholder="en, pl, de…"
                    onChange={(e) => set('language', e.target.value)}
                  />
                </Field>
                <Field label="ISBN-13" htmlFor="bf-isbn13">
                  <InputText
                    id="bf-isbn13"
                    value={form.isbn_13}
                    onChange={(e) => set('isbn_13', e.target.value)}
                  />
                </Field>
                <Field label="ISBN-10" htmlFor="bf-isbn10">
                  <InputText
                    id="bf-isbn10"
                    value={form.isbn_10}
                    onChange={(e) => set('isbn_10', e.target.value)}
                  />
                </Field>
              </div>
            </TabPanel>

            <TabPanel header="Series">
              <div className="bf-grid">
                <Field label="Series" htmlFor="bf-series">
                  <InputText
                    id="bf-series"
                    value={form.series}
                    onChange={(e) => set('series', e.target.value)}
                  />
                </Field>
                <Field label="Volume" htmlFor="bf-volume">
                  <InputText
                    id="bf-volume"
                    value={form.volume}
                    onChange={(e) => set('volume', e.target.value)}
                  />
                </Field>
                <Field label="Format" htmlFor="bf-format">
                  <InputText
                    id="bf-format"
                    value={form.format}
                    placeholder="Hardcover, Paperback, eBook…"
                    onChange={(e) => set('format', e.target.value)}
                  />
                </Field>
                <Field label="Edition" htmlFor="bf-edition">
                  <InputText
                    id="bf-edition"
                    value={form.edition}
                    onChange={(e) => set('edition', e.target.value)}
                  />
                </Field>
              </div>
            </TabPanel>

            <TabPanel header="Reading">
              <div className="bf-grid">
                <Field label="Status">
                  <Dropdown
                    value={form.status}
                    options={STATUS_OPTIONS}
                    onChange={(e) => set('status', e.value as ReadingStatus)}
                  />
                </Field>
                <Field label="Rating (stars)" error={errors.stars}>
                  <InputNumber
                    value={form.stars}
                    onValueChange={(e) => set('stars', e.value ?? null)}
                    min={0.5}
                    max={5}
                    step={0.5}
                    minFractionDigits={1}
                    maxFractionDigits={1}
                    showButtons
                    className={errors.stars ? 'p-invalid' : undefined}
                  />
                </Field>
                <Field label="Started on" error={errors.started_on}>
                  <Calendar
                    value={form.started_on}
                    onChange={(e) => set('started_on', (e.value as Date | null) ?? null)}
                    dateFormat="yy-mm-dd"
                    showButtonBar
                    readOnlyInput
                  />
                </Field>
                <Field label="Finished on" error={errors.finished_on}>
                  <Calendar
                    value={form.finished_on}
                    onChange={(e) => set('finished_on', (e.value as Date | null) ?? null)}
                    dateFormat="yy-mm-dd"
                    showButtonBar
                    readOnlyInput
                    className={errors.finished_on ? 'p-invalid' : undefined}
                  />
                </Field>
                <Field label="Pages read" error={errors.pages_read}>
                  <InputNumber
                    value={form.pages_read}
                    onValueChange={(e) => set('pages_read', e.value ?? null)}
                    min={0}
                    useGrouping={false}
                    className={errors.pages_read ? 'p-invalid' : undefined}
                  />
                </Field>
              </div>
            </TabPanel>

            <TabPanel header="Organize">
              <div className="bf-grid">
                <Field label="Shelves">
                  <Chips
                    value={form.shelves}
                    onChange={(e) => set('shelves', e.value ?? [])}
                    separator=","
                  />
                </Field>
                <Field label="Tags">
                  <Chips
                    value={form.tags}
                    onChange={(e) => set('tags', e.value ?? [])}
                    separator=","
                  />
                </Field>
                <Field label="Categories">
                  <Chips
                    value={form.categories}
                    onChange={(e) => set('categories', e.value ?? [])}
                    separator=","
                  />
                </Field>
              </div>
            </TabPanel>

            <TabPanel header="Notes">
              <div className="bf-grid bf-grid-1">
                <Field label="Description">
                  <InputTextarea
                    value={form.description}
                    onChange={(e) => set('description', e.target.value)}
                    rows={4}
                    autoResize
                  />
                </Field>
                <Field label="Notes">
                  <InputTextarea
                    value={form.notes}
                    onChange={(e) => set('notes', e.target.value)}
                    rows={3}
                    autoResize
                  />
                </Field>
                <Field label="Review">
                  <InputTextarea
                    value={form.review}
                    onChange={(e) => set('review', e.target.value)}
                    rows={3}
                    autoResize
                  />
                </Field>
              </div>
            </TabPanel>

            <TabPanel header="Purchase">
              <div className="bf-grid">
                <Field label="Purchase date">
                  <Calendar
                    value={form.purchase_date}
                    onChange={(e) => set('purchase_date', (e.value as Date | null) ?? null)}
                    dateFormat="yy-mm-dd"
                    showButtonBar
                    readOnlyInput
                  />
                </Field>
                <Field label="Purchase price" error={errors.purchase_price}>
                  <InputNumber
                    value={form.purchase_price}
                    onValueChange={(e) => set('purchase_price', e.value ?? null)}
                    min={0}
                    mode="decimal"
                    minFractionDigits={0}
                    maxFractionDigits={2}
                    className={errors.purchase_price ? 'p-invalid' : undefined}
                  />
                </Field>
                <Field label="Purchased from" htmlFor="bf-from">
                  <InputText
                    id="bf-from"
                    value={form.purchase_from}
                    onChange={(e) => set('purchase_from', e.target.value)}
                  />
                </Field>
                <Field label="Copies" error={errors.copies}>
                  <InputNumber
                    value={form.copies}
                    onValueChange={(e) => set('copies', e.value ?? null)}
                    min={0}
                    useGrouping={false}
                    className={errors.copies ? 'p-invalid' : undefined}
                  />
                </Field>
                <Field label="Condition" htmlFor="bf-condition">
                  <InputText
                    id="bf-condition"
                    value={form.condition}
                    onChange={(e) => set('condition', e.target.value)}
                  />
                </Field>
                <Field label="Signed">
                  <InputSwitch
                    checked={form.signed}
                    onChange={(e) => set('signed', e.value ?? false)}
                  />
                </Field>
              </div>
            </TabPanel>
          </TabView>
        </>
      )}
    </Dialog>
  );
}
