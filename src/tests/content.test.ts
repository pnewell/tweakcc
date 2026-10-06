import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeBunGraph, NativeBunModule } from '../nativeInstallation';

const {
  extractNativeInstallationModules,
  extractClaudeJsFromNativeInstallation,
  repackNativeInstallation,
  repackNativeInstallationModuleGraph,
} = vi.hoisted(() => ({
  extractNativeInstallationModules: vi.fn(),
  extractClaudeJsFromNativeInstallation: vi.fn(),
  repackNativeInstallation: vi.fn(),
  repackNativeInstallationModuleGraph: vi.fn(),
}));

vi.mock('../nativeInstallationLoader', () => ({
  extractNativeInstallationModules,
  extractClaudeJsFromNativeInstallation,
  repackNativeInstallation,
  repackNativeInstallationModuleGraph,
}));

import {
  patchModules,
  readContent,
  readModules,
  writeContent,
  writeModules,
} from '../lib/content';
import type { Installation } from '../lib/types';
import { findChalkVar } from '../patches/helpers';
import { PatchedModuleParseError } from '../patches/moduleParseGate';

const module = (
  name: string,
  source: string,
  loader: number
): NativeBunModule => ({
  index: 0,
  name,
  contents: Buffer.from(source),
  sourcemap: Buffer.alloc(0),
  bytecode: Buffer.alloc(0),
  moduleInfo: Buffer.alloc(0),
  bytecodeOriginPath: Buffer.alloc(0),
  encoding: 0,
  loader,
  moduleFormat: 1,
  side: 0,
  isEntryPoint: false,
});

const graph = (...modules: NativeBunModule[]): NativeBunGraph => ({
  modules,
  entryPointIndex: 0,
  flags: 0,
  compileExecArgv: Buffer.alloc(0),
  moduleRecordSize: 52,
});

const calls = 'ue.red("a");ue.bold.cyan("b");'.repeat(6);
const codeSplit = graph(
  module('/$bunfs/root/cli', 'import"./chunk-a.js";', 1),
  module('/$bunfs/root/chunk-a.js', 'var ue={};export{ue};', 1),
  module(
    '/$bunfs/root/chunk-b.js',
    `import{ue}from"/$bunfs/root/chunk-a.js";${calls}`,
    1
  ),
  module('/$bunfs/root/SKILL.md', '# Skill', 13),
  module('/$bunfs/root/rg.node', 'binary', 10)
);
// Native builds before code splitting embed helper bundles and addons too.
const singleBundle = graph(
  module('/$bunfs/root/src/entrypoints/cli.js', 'var app=1;', 1),
  module('/$bunfs/root/image-processor.js', 'var image=1;', 1),
  module('/$bunfs/root/rg.node', 'binary', 10)
);

const native: Installation = {
  path: '/bin/claude',
  version: '2.1.289',
  kind: 'native',
};

describe('code-split native content I/O', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractNativeInstallationModules.mockResolvedValue(codeSplit);
  });

  it('reads JavaScript and text modules', async () => {
    const modules = await readModules(native);
    expect([...modules!]).toEqual([
      ['/$bunfs/root/cli', 'import"./chunk-a.js";'],
      ['/$bunfs/root/chunk-a.js', 'var ue={};export{ue};'],
      [
        '/$bunfs/root/chunk-b.js',
        `import{ue}from"/$bunfs/root/chunk-a.js";${calls}`,
      ],
      ['/$bunfs/root/SKILL.md', '# Skill'],
    ]);
  });

  it('writes only the modules that changed', async () => {
    const modules = (await readModules(native))!;
    modules.set('/$bunfs/root/chunk-a.js', 'var ue={x:1};export{ue};');
    modules.set('/$bunfs/root/SKILL.md', '# Edited');

    const changed = await writeModules(native, modules);

    expect(changed).toEqual([
      '/$bunfs/root/chunk-a.js',
      '/$bunfs/root/SKILL.md',
    ]);
    const [binPath, replacements, outputPath] =
      repackNativeInstallationModuleGraph.mock.calls[0];
    expect([binPath, outputPath]).toEqual(['/bin/claude', '/bin/claude']);
    expect([...replacements.keys()]).toEqual(changed);
  });

  it('writes nothing when nothing changed', async () => {
    const modules = (await readModules(native))!;
    expect(await writeModules(native, modules)).toEqual([]);
    expect(repackNativeInstallationModuleGraph).not.toHaveBeenCalled();
  });

  it('rejects modules that are not JavaScript or text', async () => {
    await expect(
      writeModules(native, new Map([['/$bunfs/root/rg.node', 'x']]))
    ).rejects.toThrow('/$bunfs/root/rg.node');
    expect(repackNativeInstallationModuleGraph).not.toHaveBeenCalled();
  });

  it('refuses to write a JavaScript module that does not parse', async () => {
    await expect(
      writeModules(native, new Map([['/$bunfs/root/chunk-a.js', 'var ue=;']]))
    ).rejects.toThrow(PatchedModuleParseError);
    expect(repackNativeInstallationModuleGraph).not.toHaveBeenCalled();
  });

  it('patches modules with names resolved across chunks', async () => {
    const changed = await patchModules(native, (js, name) =>
      name === '/$bunfs/root/cli' ? js + `${findChalkVar(js)}.red("x");` : null
    );

    expect(changed).toEqual(['/$bunfs/root/cli', '/$bunfs/root/chunk-a.js']);
    const replacements: Map<string, Buffer> =
      repackNativeInstallationModuleGraph.mock.calls[0][1];
    expect(replacements.get('/$bunfs/root/cli')!.toString()).toContain(
      'globalThis.__tweakccExports.chunk_a_js__ue.red("x");'
    );
    expect(replacements.get('/$bunfs/root/chunk-a.js')!.toString()).toContain(
      '"chunk_a_js__ue",{get:()=>ue,'
    );
  });

  it('points readContent and writeContent at the module API', async () => {
    await expect(readContent(native)).rejects.toThrow('readModules()');
    await expect(writeContent(native, 'x')).rejects.toThrow('writeModules()');
    expect(extractClaudeJsFromNativeInstallation).not.toHaveBeenCalled();
    expect(repackNativeInstallation).not.toHaveBeenCalled();
  });
});

describe('content I/O without a code-split graph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractNativeInstallationModules.mockResolvedValue(singleBundle);
  });

  it('reads and writes a single-bundle native build as one string', async () => {
    extractClaudeJsFromNativeInstallation.mockResolvedValue(
      Buffer.from('var app=1;')
    );

    expect(await readModules(native)).toBeNull();
    expect(await readContent(native)).toBe('var app=1;');
    await writeContent(native, 'var app=2;');

    expect(repackNativeInstallation).toHaveBeenCalledWith(
      '/bin/claude',
      Buffer.from('var app=2;'),
      '/bin/claude'
    );
    await expect(writeModules(native, new Map())).rejects.toThrow(
      'writeContent()'
    );
  });
});
