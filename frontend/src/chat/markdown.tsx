import type { ReactNode } from 'react';

/** A tiny, deliberately limited Markdown renderer that returns React elements
 *  (no dangerouslySetInnerHTML, so nothing from the model can inject HTML).
 *  Supports: paragraphs, line breaks, **bold**, *italic*, `code`,
 *  `- `/`* ` bullet lists and `1. ` ordered lists. */

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] };

const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+\.\s+(.*)$/;

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'p', lines: para });
      para = [];
    }
  };

  for (const line of lines) {
    const bullet = line.match(BULLET);
    const ordered = line.match(ORDERED);
    if (bullet) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'ul') {
        last.items.push(bullet[1]);
      } else {
        blocks.push({ kind: 'ul', items: [bullet[1]] });
      }
    } else if (ordered) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'ol') {
        last.items.push(ordered[1]);
      } else {
        blocks.push({ kind: 'ol', items: [ordered[1]] });
      }
    } else if (line.trim() === '') {
      flushPara();
    } else {
      para.push(line);
    }
  }
  flushPara();
  return blocks;
}

/** Render inline spans: **bold**, *italic*, `code`. Returns React nodes. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Match the first occurrence of any inline token, left to right.
  const token = /(\*\*([^*]+?)\*\*|\*([^*]+?)\*|`([^`]+?)`)/;
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const m = rest.match(token);
    if (!m || m.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) {
      nodes.push(rest.slice(0, m.index));
    }
    const key = `${keyPrefix}-i${i++}`;
    if (m[2] !== undefined) {
      nodes.push(<strong key={key}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<em key={key}>{m[3]}</em>);
    } else if (m[4] !== undefined) {
      nodes.push(<code key={key}>{m[4]}</code>);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return nodes;
}

/** Render inline text with `\n` turned into <br/>. */
function renderLines(lines: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) {
      out.push(<br key={`${keyPrefix}-br${idx}`} />);
    }
    out.push(...renderInline(line, `${keyPrefix}-l${idx}`));
  });
  return out;
}

export function renderMarkdown(text: string): ReactNode {
  const blocks = toBlocks(text);
  return blocks.map((block, idx) => {
    const key = `b${idx}`;
    if (block.kind === 'p') {
      return <p key={key}>{renderLines(block.lines, key)}</p>;
    }
    if (block.kind === 'ul') {
      return (
        <ul key={key}>
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
          ))}
        </ul>
      );
    }
    return (
      <ol key={key}>
        {block.items.map((item, i) => (
          <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
        ))}
      </ol>
    );
  });
}
