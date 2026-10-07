/**
 * Content I/O Utilities
 *
 * Read and write Claude Code's JavaScript content.
 * Handles both npm (cli.js) and native binary installations.
 */

import * as fs from 'node:fs/promises';

import type { NativeBunGraph } from '../nativeInstallation';
import {
  extractClaudeJsFromNativeInstallation,
  extractNativeInstallationModules,
  repackNativeInstallation,
  repackNativeInstallationModuleGraph,
} from '../nativeInstallationLoader';
import { PatchGroup } from '../patches';
import { assertPatchedModuleParses } from '../patches/moduleParseGate';
import {
  applyPatchImplementationsToGraph,
  changedModuleSources,
  javaScriptModuleSources,
  textModuleSources,
} from '../patches/nativeGraphDispatcher';
import { replaceFileBreakingHardLinks } from '../utils';
import { Installation } from './types';

// ============================================================================
// Code-split native builds
// ============================================================================

/**
 * The module graph of a code-split native build (Claude Code 2.1.2xx+), whose
 * JavaScript is spread across Bun `chunk-*.js` modules. Null for npm installs
 * and for earlier native builds, which keep Claude Code in a single bundle.
 */
export async function readNativeGraph(
  installation: Installation
): Promise<NativeBunGraph | null> {
  if (installation.kind !== 'native') return null;
  const graph = await extractNativeInstallationModules(installation.path);
  return graph?.modules.some(
    module => module.loader === 1 && /\/chunk-[^/]*\.js$/.test(module.name)
  )
    ? graph
    : null;
}

/** JavaScript and text module sources of a graph. */
function graphModules(graph: NativeBunGraph): Map<string, string> {
  return new Map([
    ...javaScriptModuleSources(graph),
    ...textModuleSources(graph),
  ]);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read Claude Code's JavaScript content.
 *
 * - npm installs: reads cli.js directly
 * - native installs: extracts embedded JS from binary
 * - code-split native installs: throws; use readModules() instead
 *
 * @param installation - The installation to read from
 * @returns The JavaScript content as a string
 */
export async function readContent(installation: Installation): Promise<string> {
  if (installation.kind === 'native') {
    if (await readNativeGraph(installation)) {
      throw new Error(
        `${installation.path} is a code-split native build; use readModules() instead.`
      );
    }
    const buffer = await extractClaudeJsFromNativeInstallation(
      installation.path
    );
    if (!buffer) {
      throw new Error(
        `Failed to extract JavaScript from native installation: ${installation.path}`
      );
    }
    return buffer.toString('utf8');
  } else {
    return fs.readFile(installation.path, { encoding: 'utf8' });
  }
}

/**
 * Write modified JavaScript content back to Claude Code.
 *
 * - npm installs: writes to cli.js (handles permissions, hard links)
 * - native installs: repacks JS into binary
 * - code-split native installs: throws; use writeModules() instead
 *
 * @param installation - The installation to write to
 * @param content - The modified JavaScript content
 */
export async function writeContent(
  installation: Installation,
  content: string
): Promise<void> {
  if (installation.kind === 'native') {
    if (await readNativeGraph(installation)) {
      throw new Error(
        `${installation.path} is a code-split native build; use writeModules() instead.`
      );
    }
    const modifiedBuffer = Buffer.from(content, 'utf8');
    await repackNativeInstallation(
      installation.path,
      modifiedBuffer,
      installation.path
    );
  } else {
    await replaceFileBreakingHardLinks(installation.path, content, 'patch');
  }
}

/**
 * Read every JavaScript and text (`.md`) module of a code-split native build.
 *
 * @param installation - The installation to read from
 * @returns Module sources keyed by module name (e.g.
 *   `/$bunfs/root/chunk-abc123.js`), or null for npm installs
 *   and native builds that embed a single bundle
 */
export async function readModules(
  installation: Installation
): Promise<Map<string, string> | null> {
  const graph = await readNativeGraph(installation);
  return graph && graphModules(graph);
}

/**
 * Write modules back into a code-split native build. Every module in the map
 * whose source differs from the binary is written, so pass only the modules
 * you changed, or a map from a fresh readModules(). Every changed JavaScript
 * module must parse first; otherwise nothing is written.
 *
 * @param installation - The installation to write to
 * @param modules - Module sources keyed by name, as returned by readModules()
 * @returns Names of the modules that changed
 */
export async function writeModules(
  installation: Installation,
  modules: ReadonlyMap<string, string>
): Promise<string[]> {
  const graph = await readNativeGraph(installation);
  if (!graph) {
    throw new Error(
      `${installation.path} is not a code-split native build; use writeContent() instead.`
    );
  }
  const sources = graphModules(graph);
  const unknown = [...modules.keys()].filter(name => !sources.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Not a JavaScript or text module of ${installation.path}: ${unknown.join(', ')}`
    );
  }

  const replacements = changedModuleSources(graph, modules);
  for (const module of graph.modules) {
    const contents = replacements.get(module.name);
    if (contents && module.loader === 1) {
      assertPatchedModuleParses(module.name, contents.toString('utf8'));
    }
  }
  if (replacements.size > 0) {
    await repackNativeInstallationModuleGraph(
      installation.path,
      replacements,
      installation.path
    );
  }
  return [...replacements.keys()];
}

/**
 * Run `transform` over every JavaScript module of a code-split native build
 * and write the modules it changes, the same way tweakcc applies its own
 * patches. Helpers such as `helpers.findChalkVar()` called inside `transform`
 * return names that are valid in the module being transformed, including
 * names defined in other chunks. Return null (or throw) to skip a module.
 * Console output inside `transform` is suppressed.
 *
 * @param installation - The installation to patch
 * @param transform - Returns the new source of module `name`
 * @returns Names of the modules that changed
 */
export async function patchModules(
  installation: Installation,
  transform: (js: string, name: string) => string | null
): Promise<string[]> {
  const graph = await readNativeGraph(installation);
  if (!graph) {
    throw new Error(
      `${installation.path} is not a code-split native build; use readContent() and writeContent() instead.`
    );
  }
  const sources = javaScriptModuleSources(graph);
  applyPatchImplementationsToGraph(sources, { custom: { fn: transform } }, [
    { id: 'custom', name: 'Custom patch', group: PatchGroup.FEATURES },
  ]);
  return writeModules(installation, sources);
}
