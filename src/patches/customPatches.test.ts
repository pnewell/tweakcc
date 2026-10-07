import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PATCHES_DIR } from '../config';
import {
  applyCustomPatches,
  applyCustomPatchesToGraph,
  listCustomPatches,
} from './customPatches';

const sources = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const writePatch = (file: string, script: string) => {
  const target = path.join(PATCHES_DIR, file);
  fs.writeFileSync(target, script);
  return target;
};

beforeEach(() => {
  fs.mkdirSync(PATCHES_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(PATCHES_DIR, { recursive: true, force: true });
});

describe('listCustomPatches', () => {
  it('keys scripts by file name, letting the patches setting replace one', async () => {
    writePatch('b.js', 'return js;');
    writePatch('a.js', 'return js;');
    writePatch('notes.txt', '');
    expect([...(await listCustomPatches(['~/elsewhere/b.js']))]).toEqual([
      ['a', path.join(PATCHES_DIR, 'a.js')],
      ['b', path.join(os.homedir(), 'elsewhere/b.js')],
    ]);
  });
});

describe('applyCustomPatches', () => {
  it('runs each script over the whole bundle and fails the ones that change nothing', async () => {
    const { content, results } = await applyCustomPatches(
      'var a;',
      new Map([
        ['tag', writePatch('tag.js', 'return js + "//tag";')],
        ['miss', writePatch('miss.js', 'return js;')],
        ['bad', writePatch('bad.js', 'return js + "\\n{";')],
      ]),
      null,
      'auto'
    );
    expect(results.map(r => [r.id, r.applied, r.failed])).toEqual([
      ['tag', true, false],
      ['miss', false, true],
      ['bad', false, true],
    ]);
    expect(results[1].details).toBe('Script returned unchanged content.');
    expect(content).toBe('var a;//tag');
  });
});

describe('applyCustomPatchesToGraph', () => {
  it('applies each script in turn and fails the ones that change nothing', async () => {
    const modules = sources({ '/a.js': 'var a;', '/b.js': 'var b;' });
    const results = await applyCustomPatchesToGraph(
      modules,
      new Map([
        [
          'tag',
          writePatch('tag.js', 'return name === "/a.js" ? js + "//tag" : js;'),
        ],
        ['miss', writePatch('miss.js', 'return js;')],
        ['broken', writePatch('broken.js', 'throw new Error("no anchor");')],
      ]),
      null
    );
    expect(results.map(r => [r.id, r.applied, r.failed, r.details])).toEqual([
      ['tag', true, false, 'Updated 1 module(s).'],
      ['miss', false, true, 'Script returned unchanged content.'],
      ['broken', false, true, 'no anchor'],
    ]);
    expect(modules.get('/a.js')).toBe('var a;//tag');
  });

  it('drops a script whose output no longer parses', async () => {
    const modules = sources({ '/a.js': 'var a;' });
    const [result] = await applyCustomPatchesToGraph(
      modules,
      new Map([['bad', writePatch('bad.js', 'return js + "{";')]]),
      null
    );
    expect(result.failed).toBe(true);
    expect(result.details).toMatch(/^\/a\.js failed to parse/);
    expect(modules.get('/a.js')).toBe('var a;');
  });
});
