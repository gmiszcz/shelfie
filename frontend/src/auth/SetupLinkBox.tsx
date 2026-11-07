import { Button } from 'primereact/button';
import { useEffect, useRef, useState } from 'react';

import { SectionLabel } from '../ui';
import type { SetupLink } from './authTypes';

interface SetupLinkBoxProps {
  link: SetupLink;
  /** Heading above the link (e.g. "Setup link" / "New reset link"). */
  label: string;
}

/** Format an ISO expiry as a short local date-time. */
function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * SetupLinkBox — shows a generated setup/reset URL with a Copy button and the
 * expiry. The admin copies the link and sends it themselves (no e-mail delivery
 * in scope). Reused by the Add-person dialog and the per-row "New link" flow.
 */
export function SetupLinkBox({ link, label }: SetupLinkBoxProps) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const text = link.setup_url;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API blocked (insecure context / permissions): fall back to select.
      inputRef.current?.select();
      try {
        document.execCommand('copy');
      } catch {
        return;
      }
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="setup-link-box">
      <SectionLabel>{label}</SectionLabel>
      <div className="setup-link-row">
        <input
          ref={inputRef}
          className="setup-link-input"
          type="text"
          readOnly
          value={link.setup_url}
          aria-label="Setup link"
          onFocus={(e) => e.target.select()}
        />
        <Button
          icon={copied ? 'pi pi-check' : 'pi pi-copy'}
          label={copied ? 'Copied' : 'Copy'}
          onClick={copy}
          severity={copied ? 'success' : undefined}
        />
      </div>
      <p className="setup-link-expiry">
        Expires {formatExpiry(link.expires_at)}. Send this link to the person — it works once.
      </p>
    </div>
  );
}
