// Please see the note about writing patches in ./index
//
// Blank safety-classifier stop message
// ------------------------------------
// When Claude Code's server-side safety classifier stops a streaming
// response, the client injects a fixed notice into the conversation telling
// the model the response was withheld and "Do not produce that content again,
// even reworded." This patch blanks that notice to empty strings so the stop
// is still handled but no text is injected.
//
// It does NOT touch the classifier, which runs server-side and still stops
// responses exactly as before; this only removes the client-side message.
//
// The notice is built from three string literals (base message var `Ikr` as
// two concatenated halves, plus an "Interrupted" exception sentence appended
// for the variant var `sbo`). The minified var names change every CC version,
// so this anchors on the message copy, which is stable.
//
// CC 2.1.296:
// ```diff
// -,Ikr="Your response above was stopped by a safety classifier — this is not a tool or API error. "+"The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.",sbo=Ikr+' Exception: a tool call whose result reads "Interrupted" was already running when the response was stopped; it may have partially or fully completed.'
// +,Ikr=""+"",sbo=Ikr+''
// ```

import { showDiff } from './index';

/**
 * The three string literals that make up the stop notice, exactly as they
 * appear in the minified source (the em-dash is the escape sequence `—`,
 * i.e. a literal backslash-u-2014, not a raw em-dash byte). Each is replaced
 * by an empty literal of the same quote style, so the surrounding expression
 * stays valid JS: `Ikr=""+""` and `sbo=Ikr+''` both evaluate to "".
 */
const FRAGMENTS: ReadonlyArray<readonly [search: string, replace: string]> = [
  [
    '"Your response above was stopped by a safety classifier \\u2014 this is not a tool or API error. "',
    '""',
  ],
  [
    '"The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded."',
    '""',
  ],
  [
    '\' Exception: a tool call whose result reads "Interrupted" was already running when the response was stopped; it may have partially or fully completed.\'',
    "''",
  ],
];

// The first fragment is unique to this notice; use it as the ownership anchor.
const ANCHOR = FRAGMENTS[0][0];

/**
 * Blanks the safety-classifier stop notice.
 *
 * On a code-split graph this runs against every module; it returns `null` for
 * every module that does not contain the anchor (the dispatcher restores from
 * backup first, so it always sees the unpatched source) and rewrites the one
 * module that owns the notice.
 */
export const writeBlankClassifierStop = (file: string): string | null => {
  if (!file.includes(ANCHOR)) {
    console.error('patch: blankClassifierStop: anchor not found');
    return null;
  }

  let newFile = file;
  for (const [search, replace] of FRAGMENTS) {
    newFile = newFile.split(search).join(replace);
  }

  if (newFile === file) return null;

  const startIndex = file.indexOf(ANCHOR);
  showDiff(file, newFile, '""', startIndex, startIndex + ANCHOR.length);
  return newFile;
};
