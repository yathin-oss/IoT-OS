import type { z } from 'zod';
import { IotosError } from '../errors';

/**
 * Extracts the first JSON object from an LLM response (fenced ```json block,
 * bare object, or object embedded in prose) and validates it with a schema.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  const candidates = fenced ? [fenced[1]!, text] : [text];
  for (const c of candidates) {
    const start = c.indexOf('{');
    if (start < 0) continue;
    // Scan for the matching closing brace, respecting strings.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new IotosError('AI_MALFORMED_RESPONSE', 'The AI response did not contain a valid JSON object', {
    details: { preview: text.slice(0, 500) },
  });
}

export function parseStructured<S extends z.ZodType>(schema: S, text: string): z.infer<S> {
  const raw = extractJsonObject(text);
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new IotosError('AI_MALFORMED_RESPONSE', `The AI response did not match the expected structure:\n${issues.join('\n')}`, {
      details: { issues },
    });
  }
  return r.data;
}
