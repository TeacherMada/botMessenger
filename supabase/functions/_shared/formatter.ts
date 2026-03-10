// supabase/functions/_shared/formatter.ts
// ════════════════════════════════════════════════════════════
// FORMATTER v5.0
// ════════════════════════════════════════════════════════════
//
// Avec responseSchema (v5.0), Gemini ne génère plus de bold
// Unicode dans reply. Ce module reste léger mais complet :
//   - cleanText      : supprime tous artefacts résiduels
//   - splitMessenger : découpe intelligente ≤ 1900 chars
//   - formatAndSplit : pipeline complet pour le webhook
// ════════════════════════════════════════════════════════════

import { stripAllMathBold } from './gemini.ts';

const MAX_CHUNK = 1900;

// ── Nettoyage complet du texte avant envoi ───────────────────
export function cleanText(text: string): string {
  let t = stripAllMathBold(text);             // glyphes bold résiduels
  t = t.replace(/\*\*(.+?)\*\*/gs, '$1');     // **bold** → texte simple
  t = t.replace(/\u00a0/g, ' ');             // espaces insécables
  t = t.replace(/```[\w]*\s*/g, '').replace(/```/g, ''); // backticks
  t = t.replace(/^[ \t\u00a0]+/gm, '');      // indentations en début de ligne
  t = t.replace(/\n{3,}/g, '\n\n');          // sauts de ligne excessifs
  return t.trim();
}

// ── Découpe intelligente en morceaux Messenger-compatibles ───
export function splitMessenger(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_CHUNK) {
    let cutAt = MAX_CHUNK;

    const para = remaining.lastIndexOf('\n\n', MAX_CHUNK);
    if (para > MAX_CHUNK / 2) {
      cutAt = para + 2;
    } else {
      const ends = [
        remaining.lastIndexOf('. ',  MAX_CHUNK),
        remaining.lastIndexOf('! ',  MAX_CHUNK),
        remaining.lastIndexOf('? ',  MAX_CHUNK),
        remaining.lastIndexOf('.\n', MAX_CHUNK),
      ];
      const best = Math.max(...ends);
      if (best > MAX_CHUNK / 2) {
        cutAt = best + 1;
      } else {
        const space = remaining.lastIndexOf(' ', MAX_CHUNK);
        if (space > MAX_CHUNK / 2) cutAt = space;
      }
    }

    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks.filter(c => c.length > 0);
}

// ── Pipeline complet ─────────────────────────────────────────
export function formatAndSplit(text: string): string[] {
  return splitMessenger(cleanText(text));
}
