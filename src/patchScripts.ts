/**
 * Patch Scripts
 *
 * Runs the patch scripts of `adhoc-patch --script` and `--apply` in a sandbox.
 */

import * as fs from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';

import {
  beginGraphContext,
  endGraphContext,
  enterGraphModule,
  finishGraphModule,
  leaveGraphModule,
} from './patches/graphContext';
import {
  findChalkVar,
  getModuleLoaderFunction,
  getReactVar,
  getRequireFuncName,
  findTextComponent,
  findBoxComponent,
  clearCaches,
} from './patches/helpers';
import {
  insertBridgePublications,
  quietly,
} from './patches/nativeGraphDispatcher';

// =============================================================================
// Pre-resolved Variables for Scripts
// =============================================================================

/**
 * Pre-resolved minified variable names from Claude Code's JS content.
 * These are passed into adhoc-patch scripts as `vars` so script authors
 * don't need to run detection functions themselves (which they can't,
 * since scripts run in a sandbox with no access to tweakcc modules).
 */
interface ResolvedVars {
  /** The chalk instance variable name, e.g. "Ke" */
  chalkVar: string | undefined;
  /** The module loader function name, e.g. "T" */
  moduleLoaderFunction: string | undefined;
  /** The React variable name, e.g. "fH" */
  reactVar: string | undefined;
  /** The require function name — "require" for Bun, or a variable name for esbuild */
  requireFuncName: string;
  /** The Ink Text component function name */
  textComponent: string | undefined;
  /** The Ink Box component function name */
  boxComponent: string | undefined;
}

/**
 * Resolve all helper variables from the content.
 * Clears caches first to ensure fresh results.
 */
function resolveVars(content: string): ResolvedVars {
  clearCaches();
  return {
    chalkVar: findChalkVar(content),
    moduleLoaderFunction: getModuleLoaderFunction(content),
    reactVar: getReactVar(content),
    requireFuncName: getRequireFuncName(content),
    textComponent: findTextComponent(content),
    boxComponent: findBoxComponent(content),
  };
}

// =============================================================================
// Sandboxed Script Execution
// =============================================================================

/**
 * Executes a patch script in a sandboxed Node.js process.
 *
 * The script is run as `new Function('code', 'vars', script)` where:
 * - `code` is the JavaScript content of the Claude Code installation
 * - `vars` is an object containing pre-resolved minified variable names
 *   (chalkVar, reactVar, requireFuncName, textComponent, boxComponent, etc.)
 *
 * The script must return the modified JavaScript content.
 *
 * The sandbox uses Node's permission model with no grants, meaning the script
 * cannot read/write files, make network calls, or spawn child processes.
 *
 * Compatibility: tries `--permission` first (Node 24+), falls back to
 * `--experimental-permission` (Node 20–23). If neither is recognised the
 * user is told to upgrade to Node 20+ or rerun with
 * `--dangerous-no-script-sandbox`.
 *
 * When `noSandbox` is true the script runs without any permission flag at all
 * (useful for Node < 20 where neither flag exists).
 *
 * @param script - The script body to execute
 * @param inputCode - The JavaScript content to pass as the `code` parameter
 * @param vars - Pre-resolved minified variable names
 * @param noSandbox - If true, skip the permission sandbox entirely
 * @returns The modified JavaScript content returned by the script
 */
async function runSandboxedScript(
  script: string,
  inputCode: string,
  vars: ResolvedVars,
  noSandbox = false
): Promise<string> {
  const wrapper = `
    let input = '';
    process.stdin.on('data', c => input += c);
    process.stdin.on('end', async () => {
      try {
        const vars = ${JSON.stringify(vars)};
        process.env = {};
        const fn = new Function('js', 'vars', ${JSON.stringify(script)});
        const result = await fn(input, vars);
        process.stdout.write(JSON.stringify({"r": result}));
      } catch (e) {
        process.stderr.write(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
  `;

  return runSandboxedWrapper(wrapper, inputCode, noSandbox);
}

/** One module passed to a per-module script run: [name, js, vars]. */
type ScriptModule = [string, string, ResolvedVars];

interface ScriptModulesResult {
  /** [name, js] of every module the script changed. */
  changed: [string, string][];
  /** [name, message] of the first module the script failed on. */
  error: [string, string] | null;
  /** Number of modules the script threw on or returned a non-string for. */
  failures: number;
}

/**
 * Executes a patch script once per module of a code-split native build, in
 * the same sandbox as runSandboxedScript().
 *
 * The script is run as `new Function('js', 'vars', 'name', script)`. A module
 * the script throws on, or returns a non-string for, is left unchanged.
 */
async function runSandboxedScriptPerModule(
  script: string,
  modules: ScriptModule[],
  noSandbox = false
): Promise<ScriptModulesResult> {
  const wrapper = `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => input += c);
    process.stdin.on('end', async () => {
      try {
        const modules = JSON.parse(input);
        process.env = {};
        const fn = new Function('js', 'vars', 'name', ${JSON.stringify(script)});
        const changed = [];
        let error = null, failures = 0;
        for (const [name, js, vars] of modules) {
          try {
            const result = await fn(js, vars, name);
            if (typeof result !== 'string') {
              throw new Error('Script did not return a string. Got: ' + typeof result);
            }
            if (result !== js) changed.push([name, result]);
          } catch (e) {
            failures++;
            error ??= [name, e instanceof Error ? e.message : String(e)];
          }
        }
        process.stdout.write(JSON.stringify({"r": {changed, error, failures}}));
      } catch (e) {
        process.stderr.write(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
  `;

  return runSandboxedWrapper(wrapper, JSON.stringify(modules), noSandbox);
}

/**
 * Runs a script wrapper under the permission sandbox, falling back from
 * `--permission` to `--experimental-permission`.
 */
async function runSandboxedWrapper<T>(
  wrapper: string,
  inputCode: string,
  noSandbox: boolean
): Promise<T> {
  if (noSandbox) {
    return spawnNodeWithWrapper([], wrapper, inputCode);
  }

  // Try --permission first (Node 24+)
  try {
    return await spawnNodeWithWrapper(['--permission'], wrapper, inputCode);
  } catch (error) {
    if (isBadOptionError(error)) {
      // Fall through to try the older flag
    } else {
      throw error;
    }
  }

  // Try --experimental-permission (Node 20–23)
  try {
    return await spawnNodeWithWrapper(
      ['--experimental-permission'],
      wrapper,
      inputCode
    );
  } catch (error) {
    if (isBadOptionError(error)) {
      // Neither flag works — the Node version is too old
      const nodeVersion = getNodeVersion();
      throw new Error(
        `Your Node.js version (${nodeVersion}) does not support the permission model.\n` +
          'Please either upgrade to Node.js 20+ or rerun with --dangerous-no-script-sandbox.'
      );
    }
    throw error;
  }
}

/**
 * Returns true when an error from a spawned node process indicates that a CLI
 * flag was not recognised ("bad option").
 */
function isBadOptionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('bad option');
}

/**
 * Gets the current Node.js version string (e.g. "v18.17.0").
 */
function getNodeVersion(): string {
  try {
    return execSync('node --version', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Spawns a node process with the given extra CLI flags, feeds `inputCode` on
 * stdin, and resolves with the JSON-wrapped result from stdout.
 */
function spawnNodeWithWrapper<T>(
  extraArgs: string[],
  wrapper: string,
  inputCode: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [...extraArgs, '-e', wrapper], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));

    child.on('error', reject);
    child.stdin.on('error', () => {});

    child.on('close', code => {
      if (code !== 0)
        reject(new Error(stderr || `Script exited with code ${code}`));
      else {
        try {
          resolve(JSON.parse(stdout).r);
        } catch {
          reject(
            new Error(
              `Script returned invalid JSON output.\nstdout: ${stdout}\nstderr: ${stderr}`
            )
          );
        }
      }
    });

    child.stdin.write(inputCode);
    child.stdin.end();
  });
}

// =============================================================================
// Helper: Resolve Script Source
// =============================================================================

/**
 * Resolves the script source from a --script argument.
 *
 * - If it starts with `@`, the rest is treated as a file path or URL.
 *   - If it starts with `http://` or `https://`, it's fetched as a URL.
 *   - Otherwise, it's read as a local file.
 * - Otherwise, the argument itself is the script body.
 */
export async function resolveScriptSource(scriptArg: string): Promise<string> {
  if (!scriptArg.startsWith('@')) {
    return scriptArg;
  }

  const ref = scriptArg.slice(1);

  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    console.log(`Fetching script from ${ref}...`);
    const response = await fetch(ref);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch script from ${ref}: HTTP ${response.status} ${response.statusText}`
      );
    }
    return response.text();
  }

  console.log(`Reading script from ${ref}...`);
  return fs.readFile(ref, 'utf8');
}

// =============================================================================
// Running Scripts
// =============================================================================

/**
 * Runs a patch script over the one JavaScript bundle of a build that isn't
 * code-split, returning the patched bundle.
 */
export async function runScriptOnContent(
  script: string,
  content: string,
  noSandbox = false
): Promise<string> {
  const modified = await runSandboxedScript(
    script,
    content,
    resolveVars(content),
    noSandbox
  );
  if (typeof modified !== 'string') {
    throw new Error('Script did not return a string. Got: ' + typeof modified);
  }
  return modified;
}

/**
 * Runs a patch script over the JavaScript modules of a code-split build.
 *
 * Each module gets its own `vars`, resolved the way tweakcc's own patches see
 * them, so a name may refer to a symbol defined in another chunk. Once a
 * module that uses such a name changes, the chunk that defines the symbol
 * publishes it. Returns only the modules that changed.
 */
export async function runScriptOnModules(
  script: string,
  sources: ReadonlyMap<string, string>,
  noSandbox = false
): Promise<{
  modified: Map<string, string>;
  error: [string, string] | null;
  failures: number;
}> {
  beginGraphContext(sources);
  try {
    const modules: ScriptModule[] = [];
    for (const [name, js] of sources) {
      enterGraphModule(name);
      modules.push([name, js, quietly(() => resolveVars(js))]);
      leaveGraphModule();
    }

    const { changed, error, failures } = await runSandboxedScriptPerModule(
      script,
      modules,
      noSandbox
    );

    const modified = new Map(sources);
    for (const [name, js] of changed) {
      enterGraphModule(name);
      // Records this module's cross-chunk names again so they are published
      quietly(() => resolveVars(sources.get(name)!));
      modified.set(name, finishGraphModule(js));
      leaveGraphModule();
    }
    insertBridgePublications(modified);

    return {
      modified: new Map(
        [...modified].filter(([name, js]) => js !== sources.get(name))
      ),
      error,
      failures,
    };
  } finally {
    endGraphContext();
  }
}
