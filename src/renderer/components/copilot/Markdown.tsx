import { Fragment, type ReactNode } from 'react';

/** Minimal, safe Markdown subset (no HTML injection): code fences, lists, headings, inline code, bold. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('`') ? <code key={i++}>{tok.slice(1, -1)}</code> : <b key={i++}>{tok.slice(2, -2)}</b>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```[\w+-]*\n?/);
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      blocks.push(<pre key={`c${idx}`}>{part.replace(/\n$/, '')}</pre>);
      return;
    }
    const lines = part.split('\n');
    let list: string[] = [];
    let para: string[] = [];
    const flushList = () => {
      if (list.length) blocks.push(<ul key={`l${idx}-${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
      list = [];
    };
    const flushPara = () => {
      if (para.length) blocks.push(<p key={`p${idx}-${blocks.length}`}>{inline(para.join(' '))}</p>);
      para = [];
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      const h = /^#{1,4}\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        list.push(li[1]!);
      } else if (h) {
        flushPara();
        flushList();
        blocks.push(
          <p key={`h${idx}-${blocks.length}`}>
            <b>{inline(h[1]!)}</b>
          </p>,
        );
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
  });
  return <Fragment>{blocks}</Fragment>;
}
