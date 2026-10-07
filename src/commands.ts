/**
 * CLI Subcommand Handlers
 *
 * Implements: unpack, repack, adhoc-patch subcommands.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';

import chalk from 'chalk';

import { formatAndDiff } from './formatAndDiff';

import { tryDetectInstallation } from './lib/detection';
import {
  readContent,
  readModules,
  readNativeGraph,
  writeContent,
  writeModules,
} from './lib/content';
import { Installation } from './lib/types';
import { PatchedModuleParseError } from './patches/moduleParseGate';
import { javaScriptModuleSources } from './patches/nativeGraphDispatcher';
import {
  resolveScriptSource,
  runScriptOnContent,
  runScriptOnModules,
} from './patchScripts';

// =============================================================================
// Diff Approval
// =============================================================================

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    rl.on('close', () => settle(false));
    rl.on('SIGINT', () => settle(false));

    rl.question(prompt, answer => {
      const trimmed = answer.trim().toLowerCase();
      settle(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

/** Exported for --apply consent (and adhoc-patch). */
export { askYesNo };

function renderDiffToConsole(
  hunks: { oldStart: number; newStart: number; lines: string[] }[]
): void {
  for (const hunk of hunks) {
    console.log(chalk.cyan(`@@ -${hunk.oldStart} +${hunk.newStart} @@`));
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        console.log(chalk.green(line));
      } else if (line.startsWith('-')) {
        console.log(chalk.red(line));
      } else {
        console.log(chalk.gray(line));
      }
    }
    console.log();
  }
}

/**
 * Prints the formatted diff of one change. Returns its number of visible
 * changes, or null if no diff could be generated.
 */
async function printFormattedDiff(
  originalJs: string,
  modifiedJs: string
): Promise<number | null> {
  console.log(chalk.gray('Formatting for diff preview...'));

  const result = await formatAndDiff(originalJs, modifiedJs, {
    contextLines: 10,
  });

  if (!result) {
    console.log(
      chalk.yellow(
        'Could not generate formatted diff (oxfmt unavailable or parse error).'
      )
    );
    return null;
  }

  if (result.changeCount === 0) return 0;

  console.log(
    chalk.gray(
      `Formatted ${result.formattedLines.toLocaleString()} lines in ${result.timings.formatMs.toFixed(0)}ms\n`
    )
  );

  renderDiffToConsole(result.hunks);

  console.log(
    chalk.gray(
      `${result.changeCount} change(s) across ${result.formattedLines.toLocaleString()} formatted lines (${result.timings.totalMs.toFixed(0)}ms)`
    )
  );

  return result.changeCount;
}

/**
 * Asks once for approval of the diffs printed by printFormattedDiff().
 */
function askDiffApproval(changeCounts: (number | null)[]): Promise<boolean> {
  if (changeCounts.every(count => count === null)) {
    return askYesNo(chalk.bold('\nApply changes without diff preview? [Y/n] '));
  }

  if (changeCounts.every(count => count === 0)) {
    console.log(
      chalk.yellow('No visible differences after formatting. Proceeding.')
    );
    return Promise.resolve(true);
  }

  return askYesNo(chalk.bold('\nApply these changes? [Y/n] '));
}

export async function promptUserForDiffApproval(
  originalJs: string,
  modifiedJs: string,
  skipConfirmation = false
): Promise<boolean> {
  if (skipConfirmation) return true;

  return askDiffApproval([await printFormattedDiff(originalJs, modifiedJs)]);
}

/**
 * Shows a diff for each changed module under its name, then asks once.
 */
async function promptUserForModuleDiffApproval(
  original: ReadonlyMap<string, string>,
  modified: ReadonlyMap<string, string>,
  skipConfirmation = false
): Promise<boolean> {
  if (skipConfirmation) return true;

  const changeCounts: (number | null)[] = [];
  for (const [name, source] of modified) {
    if (source === original.get(name)) continue;
    console.log(chalk.bold(`\n${name}`));
    changeCounts.push(await printFormattedDiff(original.get(name)!, source));
  }

  return askDiffApproval(changeCounts);
}

// =============================================================================
// Helper: Resolve Installation
// =============================================================================

/**
 * Resolves an installation from an optional path argument.
 * Wraps tryDetectInstallation with consistent error handling.
 */
async function resolveInstallation(pathArg?: string): Promise<Installation> {
  try {
    return await tryDetectInstallation({
      path: pathArg,
      interactive: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}

// =============================================================================
// Helper: Write Modules
// =============================================================================

/**
 * Writes changed modules of a code-split build. If a changed module no longer
 * parses, nothing is written and the parse error is shown.
 */
async function writeModulesOrExit(
  installation: Installation,
  modules: ReadonlyMap<string, string>
): Promise<string[]> {
  try {
    return await writeModules(installation, modules);
  } catch (error) {
    if (!(error instanceof PatchedModuleParseError)) throw error;
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}

// =============================================================================
// Subcommand: unpack
// =============================================================================

/**
 * Written by unpack next to the module files: each module's SHA-256 as
 * unpacked, so repack can tell which files were edited.
 */
const UNPACK_MANIFEST = '.tweakcc-unpack.json';

function hashSource(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/**
 * A module's file path relative to the Bun root (`/$bunfs/root/` on POSIX,
 * `B:/~BUN/root/` on Windows), e.g. `chunk-abc123.js`.
 */
export function moduleFilePath(name: string): string {
  return name.replace(/^(?:\/\$bunfs|B:\/~BUN)\/root\//, '');
}

/**
 * Extract JS from a native Claude Code binary and write it to a file, or,
 * for a code-split build, every module to a directory.
 *
 * @param outputPath - Path to write the extracted JS
 * @param binaryPath - Optional path to the native binary (auto-detect if omitted)
 */
export async function handleUnpack(
  outputPath: string,
  binaryPath?: string
): Promise<void> {
  const installation = await resolveInstallation(binaryPath);

  if (installation.kind === 'npm') {
    console.error(
      chalk.red(
        'Error: Cannot unpack an npm-based installation (cli.js). Only native binaries can be unpacked.'
      )
    );
    console.error(
      chalk.gray(
        `  Detected installation: ${installation.path} (npm-based, v${installation.version})`
      )
    );
    process.exit(1);
  }

  console.log(
    `Extracting JS from native binary: ${chalk.cyan(installation.path)} (v${installation.version})`
  );

  const modules = await readModules(installation);
  if (modules) {
    const existing = await fs.readdir(outputPath).catch(() => []);
    if (existing.length > 0) {
      console.error(
        chalk.red(
          `Error: ${outputPath} is not empty. Unpack a code-split build into a new or empty directory.`
        )
      );
      process.exit(1);
    }

    const manifest: Record<string, string> = {};
    for (const [name, source] of modules) {
      const file = path.join(outputPath, moduleFilePath(name));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, source, 'utf8');
      manifest[name] = hashSource(source);
    }
    await fs.writeFile(
      path.join(outputPath, UNPACK_MANIFEST),
      JSON.stringify(manifest, null, 2)
    );

    console.log(
      chalk.green(
        `✓ Extracted ${modules.size} module(s) to ${chalk.cyan(outputPath)}`
      )
    );
    return;
  }

  const content = await readContent(installation);

  await fs.writeFile(outputPath, content, 'utf8');

  console.log(
    chalk.green(`✓ Extracted JS written to ${chalk.cyan(outputPath)}`)
  );
  console.log(
    chalk.gray(`  ${content.length.toLocaleString()} characters written`)
  );
}

// =============================================================================
// Subcommand: repack
// =============================================================================

/**
 * Read JS from a file and embed it back into a native Claude Code binary, or,
 * for a code-split build, the module files edited since unpack wrote them to
 * a directory. A module whose file is missing is left unchanged.
 *
 * @param inputPath - Path to the JS file or directory to embed
 * @param binaryPath - Optional path to the native binary (auto-detect if omitted)
 */
export async function handleRepack(
  inputPath: string,
  binaryPath?: string
): Promise<void> {
  const installation = await resolveInstallation(binaryPath);

  if (installation.kind === 'npm') {
    console.error(
      chalk.red(
        'Error: Cannot repack into an npm-based installation (cli.js). Only native binaries can be repacked.'
      )
    );
    console.error(
      chalk.gray(
        `  Detected installation: ${installation.path} (npm-based, v${installation.version})`
      )
    );
    process.exit(1);
  }

  console.log(
    `Repacking JS into native binary: ${chalk.cyan(installation.path)} (v${installation.version})`
  );

  const modules = await readModules(installation);
  const isDirectory = (await fs.stat(inputPath)).isDirectory();
  if (modules && !isDirectory) {
    console.error(
      chalk.red(
        'Error: This is a code-split build. Pass the directory written by `tweakcc unpack`, not a single file.'
      )
    );
    process.exit(1);
  }
  if (!modules && isDirectory) {
    console.error(
      chalk.red(
        'Error: This build embeds a single JS file. Pass the file written by `tweakcc unpack`, not a directory.'
      )
    );
    process.exit(1);
  }

  if (modules) {
    let manifest: Record<string, string>;
    try {
      manifest = JSON.parse(
        await fs.readFile(path.join(inputPath, UNPACK_MANIFEST), 'utf8')
      );
    } catch {
      console.error(
        chalk.red(
          `Error: ${inputPath} has no ${UNPACK_MANIFEST}. Pass a directory written by \`tweakcc unpack\`.`
        )
      );
      process.exit(1);
    }

    const names = new Map(
      Object.keys(manifest).map(name => [
        path.join(inputPath, moduleFilePath(name)),
        name,
      ])
    );
    const edited = new Map<string, string>();
    const unknown: string[] = [];
    for (const relative of await fs.readdir(inputPath, { recursive: true })) {
      const file = path.join(inputPath, relative);
      const name = names.get(file);
      if (name !== undefined) {
        const source = await fs.readFile(file, 'utf8');
        if (hashSource(source) !== manifest[name]) edited.set(name, source);
      } else if (
        relative !== UNPACK_MANIFEST &&
        !(await fs.stat(file)).isDirectory()
      ) {
        unknown.push(relative);
      }
    }

    if (unknown.length > 0) {
      console.error(
        chalk.red(
          `Error: ${unknown.length} file(s) in ${inputPath} do not match any module:`
        )
      );
      for (const relative of unknown) {
        console.error(chalk.gray(`  ${relative}`));
      }
      process.exit(1);
    }

    // Writing an edit over a module that changed since the unpack would undo
    // that change.
    const stale = [...edited.keys()].filter(name => {
      const current = modules.get(name);
      return current === undefined || hashSource(current) !== manifest[name];
    });
    if (stale.length > 0) {
      console.error(
        chalk.red(
          `Error: ${stale.length} edited module(s) changed in ${installation.path} since they were unpacked:`
        )
      );
      for (const name of stale) {
        console.error(chalk.gray(`  ${moduleFilePath(name)}`));
      }
      console.error(chalk.gray('Unpack again and redo these edits.'));
      process.exit(1);
    }

    const changed = await writeModulesOrExit(installation, edited);

    console.log(
      chalk.green(
        `✓ ${changed.length} changed module(s) from ${chalk.cyan(inputPath)} repacked into ${chalk.cyan(installation.path)}`
      )
    );
    return;
  }

  const newJs = await fs.readFile(inputPath, 'utf8');

  await writeContent(installation, newJs);

  console.log(
    chalk.green(
      `✓ JS from ${chalk.cyan(inputPath)} repacked into ${chalk.cyan(installation.path)}`
    )
  );
}

// =============================================================================
// Subcommand: adhoc-patch
// =============================================================================

/**
 * Finds and replaces occurrences in a single string, for --string and --regex.
 */
export interface Replacer {
  /** Error shown when nothing matches. */
  notFound: string;
  /** What an occurrence is called in messages, e.g. "match(es)". */
  unit: string;
  count: (content: string) => number;
  replaceAll: (content: string) => string;
  /** Replaces only the nth (0-based) occurrence. */
  replaceNth: (content: string, n: number) => string;
}

export function stringReplacer(oldString: string, newString: string): Replacer {
  return {
    notFound: 'String not found in content.',
    unit: 'occurrence(s)',
    // Use split/join for literal string replacement (no regex escaping needed)
    count: content => content.split(oldString).length - 1,
    replaceAll: content => content.split(oldString).join(newString),
    replaceNth: (content, n) => {
      const occurrences: number[] = [];
      let pos = 0;
      while (true) {
        const found = content.indexOf(oldString, pos);
        if (found === -1) break;
        occurrences.push(found);
        pos = found + oldString.length;
      }

      const replaceAt = occurrences[n];
      return (
        content.slice(0, replaceAt) +
        newString +
        content.slice(replaceAt + oldString.length)
      );
    },
  };
}

export function regexReplacer(
  pattern: string,
  flags: string,
  replacement: string
): Replacer {
  // Ensure 'g' flag is present for matchAll / replaceAll
  const globalFlags = flags.includes('g') ? flags : flags + 'g';

  return {
    notFound: 'Regex pattern not found in content.',
    unit: 'match(es)',
    count: content =>
      [...content.matchAll(new RegExp(pattern, globalFlags))].length,
    replaceAll: content =>
      content.replace(new RegExp(pattern, globalFlags), replacement),
    replaceNth: (content, n) => {
      const match = [...content.matchAll(new RegExp(pattern, globalFlags))][n];
      const matchStart = match.index!;
      const matchEnd = matchStart + match[0].length;

      // Build the replacement string with group substitutions
      const resolvedReplacement = match[0].replace(
        new RegExp(pattern, flags),
        replacement
      );

      return (
        content.slice(0, matchStart) +
        resolvedReplacement +
        content.slice(matchEnd)
      );
    },
  };
}

/**
 * Applies a replacer to each source in order. With `index` (1-based), only
 * that occurrence is replaced, counting across all sources in order. Throws
 * if nothing matches or `index` is out of range.
 */
export function replaceInSources(
  sources: ReadonlyMap<string, string>,
  replacer: Replacer,
  index: number | undefined
): { modified: Map<string, string>; count: number } {
  const counts = [...sources.values()].map(replacer.count);
  const total = counts.reduce((sum, count) => sum + count, 0);

  if (total === 0) {
    throw new Error(replacer.notFound);
  }

  if (index !== undefined && (index < 1 || index > total)) {
    throw new Error(
      `Index ${index} is out of range. Found ${total} ${replacer.unit}.`
    );
  }

  const modified = new Map(sources);
  let skip = index === undefined ? 0 : index - 1;
  for (const [i, [name, content]] of [...sources].entries()) {
    if (index === undefined) {
      if (counts[i] > 0) modified.set(name, replacer.replaceAll(content));
    } else if (skip < counts[i]) {
      modified.set(name, replacer.replaceNth(content, skip));
      break;
    } else {
      skip -= counts[i];
    }
  }

  return { modified, count: index === undefined ? total : 1 };
}

/**
 * Apply a string or regex replacement patch, across every module of a
 * code-split native build.
 */
async function handleAdhocPatchReplace(
  replacer: Replacer,
  index: number | undefined,
  installation: Installation,
  skipConfirmation = false
): Promise<void> {
  const modules = await readModules(installation);
  const sources =
    modules ?? new Map([[installation.path, await readContent(installation)]]);

  let result: ReturnType<typeof replaceInSources>;
  try {
    result = replaceInSources(sources, replacer, index);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
  const { modified, count } = result;

  if (modules) {
    const approved = await promptUserForModuleDiffApproval(
      sources,
      modified,
      skipConfirmation
    );
    if (!approved) {
      console.log(chalk.yellow('Aborted.'));
      return;
    }

    const changed = await writeModulesOrExit(installation, modified);

    console.log(
      chalk.green(
        `✓ Replaced ${count} ${replacer.unit} in ${changed.length} module(s) of ${chalk.cyan(installation.path)}`
      )
    );
    return;
  }

  const approved = await promptUserForDiffApproval(
    sources.get(installation.path)!,
    modified.get(installation.path)!,
    skipConfirmation
  );
  if (!approved) {
    console.log(chalk.yellow('Aborted.'));
    return;
  }

  await writeContent(installation, modified.get(installation.path)!);

  console.log(
    chalk.green(
      `✓ Replaced ${count} ${replacer.unit} in ${chalk.cyan(installation.path)}`
    )
  );
}

/**
 * Apply a string replacement patch.
 */
async function handleAdhocPatchString(
  oldString: string,
  newString: string,
  index: number | undefined,
  installation: Installation,
  skipConfirmation = false
): Promise<void> {
  await handleAdhocPatchReplace(
    stringReplacer(oldString, newString),
    index,
    installation,
    skipConfirmation
  );
}

/**
 * Parse a regex string in /pattern/flags format.
 * If no delimiters are present, treats the entire string as the pattern with no flags.
 *
 * Examples:
 *   "/cl([a-z0-9]+)de/i"  → { pattern: "cl([a-z0-9]+)de", flags: "i" }
 *   "/foo\\/bar/"          → { pattern: "foo\\/bar", flags: "" }
 *   "foo.*bar"             → { pattern: "foo.*bar", flags: "" }
 */
function parseRegexLiteral(input: string): { pattern: string; flags: string } {
  if (input.startsWith('/')) {
    // Find the last / that isn't escaped
    let lastSlash = -1;
    for (let i = input.length - 1; i > 0; i--) {
      if (input[i] === '/') {
        // Check it's not escaped (count preceding backslashes)
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && input[j] === '\\'; j--) {
          backslashes++;
        }
        if (backslashes % 2 === 0) {
          lastSlash = i;
          break;
        }
      }
    }

    if (lastSlash > 0) {
      const pattern = input.slice(1, lastSlash);
      const flags = input.slice(lastSlash + 1);

      // Validate flags
      const validFlags = /^[gimsuy]*$/;
      if (!validFlags.test(flags)) {
        throw new Error(
          `Invalid regex flags: "${flags}". Valid flags are: g, i, m, s, u, y`
        );
      }

      return { pattern, flags };
    }
  }

  // No /.../ delimiters — treat as raw pattern with no flags
  return { pattern: input, flags: '' };
}

/**
 * Apply a regex replacement patch.
 */
async function handleAdhocPatchRegex(
  rawPattern: string,
  replacement: string,
  index: number | undefined,
  installation: Installation,
  skipConfirmation = false
): Promise<void> {
  let parsed: { pattern: string; flags: string };
  try {
    parsed = parseRegexLiteral(rawPattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }

  await handleAdhocPatchReplace(
    regexReplacer(parsed.pattern, parsed.flags, replacement),
    index,
    installation,
    skipConfirmation
  );
}

/**
 * Apply a script-based patch to every JavaScript module of a code-split
 * native build.
 */
async function handleAdhocPatchScriptModules(
  script: string,
  sources: Map<string, string>,
  installation: Installation,
  skipConfirmation: boolean,
  dangerousNoScriptSandbox: boolean
): Promise<void> {
  console.log(
    dangerousNoScriptSandbox
      ? `Running patch script on ${sources.size} modules WITHOUT sandbox (--dangerous-no-script-sandbox)...`
      : `Running patch script on ${sources.size} modules in sandbox...`
  );
  let result: Awaited<ReturnType<typeof runScriptOnModules>>;
  try {
    result = await runScriptOnModules(
      script,
      sources,
      dangerousNoScriptSandbox
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: Script execution failed:`));
    console.error(chalk.red(`  ${message}`));
    process.exit(1);
  }

  if (result.error && result.modified.size === 0) {
    console.error(
      chalk.red(
        `Error: Script failed in ${result.failures} of ${sources.size} module(s) and changed none. First error, in ${result.error[0]}:`
      )
    );
    console.error(chalk.red(`  ${result.error[1]}`));
    process.exit(1);
  }

  if (result.modified.size === 0) {
    console.log(
      chalk.yellow('Script returned unchanged content. Nothing to do.')
    );
    return;
  }

  if (result.error) {
    console.log(
      chalk.gray(
        `${result.failures} module(s) skipped because the script threw (first, in ${result.error[0]}: ${result.error[1]})`
      )
    );
  }

  const approved = await promptUserForModuleDiffApproval(
    sources,
    result.modified,
    skipConfirmation
  );
  if (!approved) {
    console.log(chalk.yellow('Aborted.'));
    return;
  }

  const changed = await writeModulesOrExit(installation, result.modified);

  console.log(
    chalk.green(
      `✓ Script patch applied to ${changed.length} module(s) of ${chalk.cyan(installation.path)}`
    )
  );
}

/**
 * Apply a script-based patch.
 */
async function handleAdhocPatchScriptImpl(
  scriptArg: string,
  installation: Installation,
  skipConfirmation = false,
  dangerousNoScriptSandbox = false
): Promise<void> {
  const graph = await readNativeGraph(installation);
  if (graph) {
    const script = await resolveScriptSource(scriptArg);
    console.log('Resolving variables...');
    await handleAdhocPatchScriptModules(
      script,
      javaScriptModuleSources(graph),
      installation,
      skipConfirmation,
      dangerousNoScriptSandbox
    );
    return;
  }

  const content = await readContent(installation);

  const script = await resolveScriptSource(scriptArg);

  console.log('Resolving variables...');
  console.log(
    dangerousNoScriptSandbox
      ? 'Running patch script WITHOUT sandbox (--dangerous-no-script-sandbox)...'
      : 'Running patch script in sandbox...'
  );
  let modified: string;
  try {
    modified = await runScriptOnContent(
      script,
      content,
      dangerousNoScriptSandbox
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: Script execution failed:`));
    console.error(chalk.red(`  ${message}`));
    process.exit(1);
  }

  if (modified === content) {
    console.log(
      chalk.yellow('Script returned unchanged content. Nothing to do.')
    );
    return;
  }

  const approved = await promptUserForDiffApproval(
    content,
    modified,
    skipConfirmation
  );
  if (!approved) {
    console.log(chalk.yellow('Aborted.'));
    return;
  }

  await writeContent(installation, modified);

  console.log(
    chalk.green(`✓ Script patch applied to ${chalk.cyan(installation.path)}`)
  );
}

// =============================================================================
// Subcommand: adhoc-patch (dispatcher)
// =============================================================================

/**
 * Main handler for the adhoc-patch subcommand.
 * Routes to string, regex, or script handler based on which option was provided.
 */
export async function handleAdhocPatch(options: {
  string?: string[];
  regex?: string[];
  script?: string;
  index?: number;
  path?: string;
  confirmPossibleDangerousPatch?: boolean;
  dangerousNoScriptSandbox?: boolean;
}): Promise<void> {
  // Validate that exactly one mode is specified
  const modes = [options.string, options.regex, options.script].filter(
    m => m !== undefined
  );
  if (modes.length === 0) {
    console.error(
      chalk.red('Error: Must specify one of --string, --regex, or --script.')
    );
    process.exit(1);
  }
  if (modes.length > 1) {
    console.error(
      chalk.red(
        'Error: Only one of --string, --regex, or --script can be used at a time.'
      )
    );
    process.exit(1);
  }

  const skipConfirmation = !!options.confirmPossibleDangerousPatch;
  const installation = await resolveInstallation(options.path);

  console.log(
    `Target: ${chalk.cyan(installation.path)} (${installation.kind}, v${installation.version})`
  );

  if (options.string) {
    if (options.string.length !== 2) {
      console.error(
        chalk.red(
          'Error: --string requires exactly 2 arguments: <old-string> <new-string>'
        )
      );
      process.exit(1);
    }
    await handleAdhocPatchString(
      options.string[0],
      options.string[1],
      options.index,
      installation,
      skipConfirmation
    );
  } else if (options.regex) {
    if (options.regex.length !== 2) {
      console.error(
        chalk.red(
          'Error: --regex requires exactly 2 arguments: <pattern> <replacement>'
        )
      );
      process.exit(1);
    }
    await handleAdhocPatchRegex(
      options.regex[0],
      options.regex[1],
      options.index,
      installation,
      skipConfirmation
    );
  } else if (options.script) {
    if (options.index !== undefined) {
      console.error(chalk.red('Error: --index cannot be used with --script.'));
      process.exit(1);
    }
    await handleAdhocPatchScriptImpl(
      options.script,
      installation,
      skipConfirmation,
      !!options.dangerousNoScriptSandbox
    );
  }
}
