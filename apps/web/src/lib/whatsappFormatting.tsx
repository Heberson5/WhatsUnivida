import type { ReactNode } from "react";

const URL_PATTERN = /https?:\/\/[^\s]+/g;
// Trailing characters that almost always belong to the surrounding sentence,
// not the URL itself (a link at the end of "veja isso: https://x.com." must
// not swallow the period) — stripped off each match, one full pass so a run
// of them (").") comes off together rather than one at a time.
const TRAILING_PUNCTUATION = /[.,;:!?'")\]]+$/;

/** Turns every bare http(s) URL in a plain-text run into a clickable link — WhatsApp Web parity for a message with no rich link-preview card (see MessageBubble's linkPreview), and a fallback even when there is one. */
function linkifyPlainText(text: string, keyRef: { current: number }): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    let url = match[0];
    const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    if (trailing) url = url.slice(0, -trailing.length);
    if (!url) continue;
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(
      <a key={`url-${keyRef.current++}`} href={url} target="_blank" rel="noreferrer" className="underline break-all">
        {url}
      </a>
    );
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

/**
 * Renders WhatsApp's own inline text markup — bold, italic, strikethrough
 * and monospace markers, the same convention its official apps already
 * interpret — as React nodes, and turns any bare URL into a clickable link.
 * Applies uniformly to inbound and outbound message bodies: WhatsApp carries
 * the literal marker characters in the message text itself, so a message
 * typed with this markup on either end needs the same rendering here.
 * Single-pass, non-nested (WhatsApp's own formatting doesn't nest either).
 */
export function renderWhatsAppFormatting(text: string): ReactNode[] {
  // Order matters: monospace (```...```) is checked first since its content
  // must never be reinterpreted for bold/italic/strike markers inside it.
  const pattern = /```([^`\n]+)```|(?<![*\w])\*([^*\n]+)\*(?![*\w])|(?<![_\w])_([^_\n]+)_(?![_\w])|(?<![~\w])~([^~\n]+)~(?![~\w])/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  const linkKeyRef = { current: 0 };

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(...linkifyPlainText(text.slice(lastIndex, match.index), linkKeyRef));
    const [, mono, bold, italic, strike] = match;
    if (mono !== undefined) nodes.push(<code key={`fmt-${key++}`} className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.9em]">{mono}</code>);
    else if (bold !== undefined) nodes.push(<strong key={`fmt-${key++}`}>{bold}</strong>);
    else if (italic !== undefined) nodes.push(<em key={`fmt-${key++}`}>{italic}</em>);
    else if (strike !== undefined) nodes.push(<s key={`fmt-${key++}`}>{strike}</s>);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(...linkifyPlainText(text.slice(lastIndex), linkKeyRef));
  return nodes;
}
