import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeBunGraph, NativeBunModule } from '../nativeInstallation';

const {
  extractNativeInstallationModules,
  repackNativeInstallationModuleGraph,
} = vi.hoisted(() => ({
  extractNativeInstallationModules: vi.fn(),
  repackNativeInstallationModuleGraph: vi.fn(),
}));

vi.mock('../nativeInstallationLoader', () => ({
  extractNativeInstallationModules,
  repackNativeInstallationModuleGraph,
}));
vi.mock('../lib/detection', () => ({
  tryDetectInstallation: async () => ({
    path: '/bin/claude',
    version: '2.1.289',
    kind: 'native',
  }),
}));

import {
  handleRepack,
  handleUnpack,
  moduleFilePath,
  regexReplacer,
  replaceInSources,
  runScriptOnModules,
  stringReplacer,
} from '../commands';

const sources = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const module = (name: string, source: string): NativeBunModule => ({
  index: 0,
  name,
  contents: Buffer.from(source),
  sourcemap: Buffer.alloc(0),
  bytecode: Buffer.alloc(0),
  moduleInfo: Buffer.alloc(0),
  bytecodeOriginPath: Buffer.alloc(0),
  encoding: 0,
  loader: name.endsWith('.md') ? 13 : 1,
  moduleFormat: 1,
  side: 0,
  isEntryPoint: false,
});

const graph = (entries: Record<string, string>): NativeBunGraph => ({
  modules: Object.entries(entries).map(([name, source]) =>
    module(name, source)
  ),
  entryPointIndex: 0,
  flags: 0,
  compileExecArgv: Buffer.alloc(0),
  moduleRecordSize: 52,
});

const mockExit = () =>
  vi.spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`exit ${code}`);
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('adhoc-patch replacements across modules', () => {
  const modules = sources({
    '/a.js': 'x=1;x=2;',
    '/b.js': 'y=1;',
    '/c.md': 'x=3',
  });

  it('replaces every occurrence in every module', () => {
    const { modified, count } = replaceInSources(
      modules,
      stringReplacer('x=', 'z='),
      undefined
    );
    expect(count).toBe(3);
    expect([...modified.values()]).toEqual(['z=1;z=2;', 'y=1;', 'z=3']);
  });

  it('counts --index across module boundaries', () => {
    const { modified, count } = replaceInSources(
      modules,
      regexReplacer('x=(\\d)', '', 'x=[$1]'),
      3
    );
    expect(count).toBe(1);
    expect([...modified.values()]).toEqual(['x=1;x=2;', 'y=1;', 'x=[3]']);
  });

  it('throws when the index is out of range', () => {
    expect(() =>
      replaceInSources(modules, stringReplacer('x=', 'z='), 4)
    ).toThrow('Index 4 is out of range. Found 3 occurrence(s).');
  });
});

describe('adhoc-patch --script across modules', () => {
  it('runs once per module and returns only the modules it changed', async () => {
    const result = await runScriptOnModules(
      `if (name === '/b.js') throw new Error('no anchor');
       return name === '/a.js' ? js + '//' + name : js;`,
      sources({ '/a.js': 'var a;', '/b.js': 'var b;', '/c.js': 'var c;' })
    );
    expect([...result.modified]).toEqual([['/a.js', 'var a;///a.js']]);
    expect(result.error).toEqual(['/b.js', 'no anchor']);
    expect(result.failures).toBe(1);
  });

  it('publishes symbols a changed module reaches through vars', async () => {
    const calls = 'ue.red("a");ue.bold.cyan("b");'.repeat(6);
    const result = await runScriptOnModules(
      'return name.endsWith("/c.js") ? js + vars.chalkVar + `.red("x");` : js;',
      sources({
        '/$bunfs/root/chalk.js': 'var ue={};export{ue};',
        '/$bunfs/root/user.js': `import{ue}from"/$bunfs/root/chalk.js";${calls}`,
        '/$bunfs/root/c.js': 'var a=1;',
      })
    );
    expect([...result.modified.keys()]).toEqual([
      '/$bunfs/root/chalk.js',
      '/$bunfs/root/c.js',
    ]);
    expect(result.modified.get('/$bunfs/root/c.js')).toBe(
      'var a=1;globalThis.__tweakccExports.chalk_js__ue.red("x");'
    );
    expect(result.modified.get('/$bunfs/root/chalk.js')).toContain(
      '"chalk_js__ue",{get:()=>ue,'
    );
  });
});

describe('unpack and repack of code-split builds', () => {
  const unpacked = {
    '/$bunfs/root/cli': 'import"./chunk-a.js";',
    '/$bunfs/root/chunk-a.js': 'var a="Ready to code?";',
    '/$bunfs/root/src/hooks/worker.js': 'var w;',
    '/$bunfs/root/SKILL.md': '# Skill',
  };
  let dir: string;

  const replacedModules = () =>
    Object.fromEntries(
      [
        ...(repackNativeInstallationModuleGraph.mock.calls[0][1] as Map<
          string,
          Buffer
        >),
      ].map(([name, contents]) => [name, contents.toString()])
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-unpack-'));
    extractNativeInstallationModules.mockResolvedValue(graph(unpacked));
    await handleUnpack(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps module names to paths under the Bun root', () => {
    expect(moduleFilePath('/$bunfs/root/chunk-a.js')).toBe('chunk-a.js');
    expect(moduleFilePath('B:/~BUN/root/src/hooks/worker.js')).toBe(
      'src/hooks/worker.js'
    );
  });

  it('writes back only the files edited since the unpack', async () => {
    fs.writeFileSync(path.join(dir, 'chunk-a.js'), 'var a="Ready to tweak?";');
    // A missing file leaves its module unchanged.
    fs.rmSync(path.join(dir, 'SKILL.md'));

    await handleRepack(dir);

    expect(replacedModules()).toEqual({
      '/$bunfs/root/chunk-a.js': 'var a="Ready to tweak?";',
    });
  });

  it('keeps changes made to the binary after the unpack', async () => {
    extractNativeInstallationModules.mockResolvedValue(
      graph({ ...unpacked, '/$bunfs/root/cli': 'import"./chunk-b.js";' })
    );
    fs.writeFileSync(path.join(dir, 'chunk-a.js'), 'var a="Ready to tweak?";');

    await handleRepack(dir);

    expect(replacedModules()).toEqual({
      '/$bunfs/root/chunk-a.js': 'var a="Ready to tweak?";',
    });
  });

  it('refuses edits to modules the binary changed after the unpack', async () => {
    extractNativeInstallationModules.mockResolvedValue(
      graph({ ...unpacked, '/$bunfs/root/chunk-a.js': 'var a="Ready?";' })
    );
    fs.writeFileSync(path.join(dir, 'chunk-a.js'), 'var a="Ready to tweak?";');
    mockExit();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleRepack(dir)).rejects.toThrow('exit 1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('chunk-a.js'));
    expect(repackNativeInstallationModuleGraph).not.toHaveBeenCalled();
  });

  it('rejects files that do not match any module', async () => {
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', 'todo.txt'), '');
    mockExit();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleRepack(dir)).rejects.toThrow('exit 1');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(path.join('notes', 'todo.txt'))
    );
    expect(repackNativeInstallationModuleGraph).not.toHaveBeenCalled();
  });

  it('reports an edit that does not parse without writing', async () => {
    fs.writeFileSync(path.join(dir, 'chunk-a.js'), 'var a=;');
    mockExit();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleRepack(dir)).rejects.toThrow('exit 1');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('/$bunfs/root/chunk-a.js failed to parse')
    );
    expect(repackNativeInstallationModuleGraph).not.toHaveBeenCalled();
  });

  it('refuses to unpack into a non-empty directory', async () => {
    mockExit();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleUnpack(dir)).rejects.toThrow('exit 1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not empty'));
  });
});
