import { describe, expect, it } from 'vitest';

import { writeBlankClassifierStop } from './blankClassifierStop';

// Real CC 2.1.296 excerpt: the safety-classifier stop notice as two vars.
const NOTICE =
  ',Ikr="Your response above was stopped by a safety classifier \\u2014 this is not a tool or API error. "+"The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.",sbo=Ikr+\' Exception: a tool call whose result reads "Interrupted" was already running when the response was stopped; it may have partially or fully completed.\',Bct="Output token limit hit.";';

describe('writeBlankClassifierStop', () => {
  it('blanks all three fragments to empty literals, leaving valid JS', () => {
    const result = writeBlankClassifierStop(NOTICE);
    expect(result).not.toBeNull();
    expect(result).toContain(
      ',Ikr=""+"",sbo=Ikr+\'\',Bct="Output token limit hit.";'
    );
    expect(result).not.toContain('safety classifier');
    expect(result).not.toContain('even reworded');
    expect(result).not.toContain('Interrupted');
  });

  it('returns null for a module without the notice', () => {
    expect(writeBlankClassifierStop('const x=1;export{x};')).toBeNull();
  });
});
