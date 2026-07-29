// Deterministic fix-ups for coined proper nouns that local whisper models
// reliably mangle (base.en AND medium both miss rare/coined terms; the vocab
// --prompt doesn't fix it). High-precision only: each entry maps a near-certain
// mishear (or just wrong casing) of a coined term to its correct spelling.
//
// Deliberately NOT included: real English words whisper sometimes emits for a
// coined term — mapping those would corrupt legit sentences. Only correct
// spellings that are themselves coined/rare, so a false positive is very
// unlikely. Applied whole-word, case-insensitive.
//
// This ships empty by default. Add your own domain-specific proper-noun
// corrections here as [pattern, replacement] pairs, e.g.:
//   [/\bwidget[\s-]?works\b/gi, 'WidgetWorks'],

const CORRECTIONS: Array<[RegExp, string]> = [
  // Example (generic): normalize the app's own name casing.
  [/\broca\b/gi, 'ROCA'],
]

/** Fix known proper-noun mishears/casing in a transcript. */
export function applySttCorrections(text: string): string {
  let out = text
  for (const [re, replacement] of CORRECTIONS) out = out.replace(re, replacement)
  return out
}
