import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';
import { ProgressSpinner } from 'primereact/progressspinner';
import { useRef, useState } from 'react';

import { api } from '../services/api';
import type { VolumeSearchResult } from '../types';
import './CoverPicker.css';

const ACCEPT = 'image/jpeg,image/png,image/webp';
const MAX_BYTES = 10 * 1024 * 1024;

interface Props {
  value: string | null;
  onChange: (url: string | null) => void;
  title: string;
  authors: string[];
  isbn: string;
}

export function CoverPicker({ value, onChange, title, authors, isbn }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [hits, setHits] = useState<VolumeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const findOnline = async () => {
    const trimmedIsbn = isbn.trim();
    const q = trimmedIsbn
      ? `isbn:${trimmedIsbn}`
      : `${title.trim()} ${authors[0]?.trim() ?? ''}`.trim();
    if (!q) {
      setError('Enter a title or ISBN first.');
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const resp = await api.search(q);
      const covers = resp.items.filter((h) => h.cover_url);
      setHits(covers);
      if (covers.length === 0) {
        setError('No covers found online for this book.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cover search failed.');
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Image is larger than 10 MB.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const url = await api.uploadCover(file);
      onChange(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const applyUrl = () => {
    const url = urlDraft.trim();
    if (!url) {
      return;
    }
    onChange(url);
    setUrlDraft('');
    setShowUrl(false);
    setError(null);
  };

  return (
    <div className="cover-picker">
      <div className="cover-preview">
        {value ? (
          <img src={value} alt="Cover preview" />
        ) : (
          <i className="pi pi-book" aria-hidden="true" />
        )}
      </div>

      <div className="cover-actions">
        <div className="flex gap-2 flex-wrap">
          <Button
            type="button"
            label="Find online"
            icon="pi pi-search"
            size="small"
            outlined
            loading={searching}
            onClick={() => void findOnline()}
          />
          <Button
            type="button"
            label="Upload"
            icon="pi pi-upload"
            size="small"
            outlined
            loading={uploading}
            onClick={() => fileRef.current?.click()}
          />
          <Button
            type="button"
            label="Paste URL"
            icon="pi pi-link"
            size="small"
            outlined
            onClick={() => setShowUrl((v) => !v)}
          />
          {value && (
            <Button
              type="button"
              label="Remove"
              icon="pi pi-times"
              size="small"
              severity="danger"
              text
              onClick={() => onChange(null)}
            />
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => void onFile(e)}
        />

        {showUrl && (
          <div className="flex gap-2">
            <InputText
              value={urlDraft}
              placeholder="https://example.com/cover.jpg"
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyUrl();
              }}
              style={{ flex: 1 }}
            />
            <Button type="button" label="Set" size="small" onClick={applyUrl} />
          </div>
        )}

        {error && <small className="cover-error">{error}</small>}

        {searching && (
          <div className="flex justify-content-center p-2">
            <ProgressSpinner style={{ width: '32px', height: '32px' }} />
          </div>
        )}

        {hits.length > 0 && (
          <div className="cover-hit-grid">
            {hits.map((hit, i) => (
              <button
                key={hit.google_volume_id ?? `${hit.title}-${i}`}
                type="button"
                className={`cover-hit ${value === hit.cover_url ? 'selected' : ''}`}
                title={hit.title}
                onClick={() => {
                  onChange(hit.cover_url);
                  setError(null);
                }}
              >
                <img src={hit.cover_url ?? ''} alt={hit.title} loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
