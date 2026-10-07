import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { PATCHES_DIR } from '../config';
import {
  resolveScriptSource,
  runScriptOnContent,
  runScriptOnModules,
} from '../patchScripts';
import { debug, expandTilde } from '../utils';
import { PatchGroup, type PatchResult } from './index';
import {
  assertPatchedModuleParses,
  PatchedModuleParseError,
} from './moduleParseGate';
import { assertPatchedBundleParses } from './parseGate';

const UNCHANGED = 'Script returned unchanged content.';

/**
 * Patch scripts to run on `--apply`, keyed by id (the file name without
 * `.js`): every `*.js` in PATCHES_DIR, then the `patches` setting's paths and
 * URLs. A script whose id matches a built-in patch replaces that patch.
 */
export const listCustomPatches = async (
  entries: readonly string[]
): Promise<Map<string, string>> => {
  const patches = new Map<string, string>();
  try {
    const files = (await fs.readdir(PATCHES_DIR))
      .filter(file => file.endsWith('.js'))
      .sort();
    for (const file of files)
      patches.set(path.basename(file, '.js'), path.join(PATCHES_DIR, file));
  } catch (error) {
    debug(`No patch scripts read from ${PATCHES_DIR}:`, error);
  }
  for (const entry of entries)
    patches.set(path.basename(entry, '.js'), expandTilde(entry));
  return patches;
};

/**
 * Runs each patch script, after the built-in patches, as `tweakcc adhoc-patch
 * --script` would. `apply` returns the result's details or throws; since the
 * apply starts from the backup, a script that changes nothing failed to find
 * its anchor. A failed script's changes are dropped and the others still run.
 */
const applyEach = async (
  patches: ReadonlyMap<string, string>,
  patchFilter: readonly string[] | null | undefined,
  apply: (script: string) => Promise<string | undefined>
): Promise<PatchResult[]> => {
  const results: PatchResult[] = [];
  for (const [id, source] of patches) {
    const base = { id, name: path.basename(source), group: PatchGroup.CUSTOM };
    if (patchFilter && !patchFilter.includes(id)) {
      results.push({ ...base, applied: false, skipped: true });
      continue;
    }
    try {
      const details = await apply(await resolveScriptSource(`@${source}`));
      results.push({ ...base, applied: true, failed: false, details });
    } catch (error) {
      results.push({
        ...base,
        applied: false,
        failed: true,
        details:
          error instanceof PatchedModuleParseError
            ? `${error.moduleName} failed to parse (${error.diagnostic.replaceAll('\n', '; ')})`
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }
  return results;
};

/** Runs the patch scripts over a single-bundle build's JavaScript. */
export const applyCustomPatches = async (
  content: string,
  patches: ReadonlyMap<string, string>,
  patchFilter: readonly string[] | null | undefined,
  sourceType: 'auto' | 'module'
): Promise<{ content: string; results: PatchResult[] }> => {
  const results = await applyEach(patches, patchFilter, async script => {
    const patched = await runScriptOnContent(script, content);
    if (patched === content) throw new Error(UNCHANGED);
    assertPatchedBundleParses(patched, sourceType);
    content = patched;
    return undefined;
  });
  return { content, results };
};

/** Runs the patch scripts over a code-split build's JavaScript modules. */
export const applyCustomPatchesToGraph = (
  sources: Map<string, string>,
  patches: ReadonlyMap<string, string>,
  patchFilter: readonly string[] | null | undefined
): Promise<PatchResult[]> =>
  applyEach(patches, patchFilter, async script => {
    const { modified, error } = await runScriptOnModules(script, sources);
    if (modified.size === 0) throw new Error(error?.[1] ?? UNCHANGED);
    for (const [name, js] of modified) assertPatchedModuleParses(name, js);
    for (const [name, js] of modified) sources.set(name, js);
    return `Updated ${modified.size} module(s).`;
  });
