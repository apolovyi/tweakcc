/**
 * Content I/O Utilities
 *
 * Read and write Claude Code's JavaScript content.
 * Handles both npm (cli.js) and native binary installations.
 */

import * as fs from 'node:fs/promises';

import {
  extractClaudeJsFromNativeInstallation,
  extractClaudeJsModulesFromNativeInstallation,
  repackNativeInstallation,
  repackNativeInstallationModules,
} from '../nativeInstallationLoader';
import type {
  BunModuleReplacement,
  ExtractedBunModule,
} from '../nativeInstallation';
import { replaceFileBreakingHardLinks } from '../utils';
import { Installation } from './types';

// Bun's Text loader. Embedded Markdown/TXT prompts are runtime strings, so they
// are patchable text; File/NAPI loaders hold binary payloads and stay opaque.
// oven-sh/bun@4661e494, src/ast/loader.rs: Loader::Text = 13.
const BUN_TEXT_LOADER = 13;

/** Decode an embedded module according to Bun's serialized string encoding. */
export function decodeNativeModuleSource(module: ExtractedBunModule): string {
  // Bun 1.4.1 reused the never-written Utf8 tag (2) for little-endian UTF-16;
  // decoding it as UTF-8 corrupts source before any matcher sees it.
  // The enum and to_wtf_string agree on 0=UTF-8, 1=Latin-1, 2=UTF-16:
  // https://github.com/oven-sh/bun/blob/4661e494f052c83c80dade1318e5710238340be6/src/standalone_graph/StandaloneModuleGraph.rs#L407-L419
  if (module.encoding === 2) return module.contents.toString('utf16le');
  if (module.encoding === 1) return module.contents.toString('latin1');
  if (module.encoding === 0) return module.contents.toString('utf8');
  throw new Error(`Unsupported Bun source encoding: ${module.encoding}`);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read Claude Code's JavaScript content.
 *
 * - npm installs: reads cli.js directly
 * - native installs: extracts embedded JS from binary
 *
 * @param installation - The installation to read from
 * @returns The JavaScript content as a string
 */
export async function readContent(installation: Installation): Promise<string> {
  if (installation.kind === 'native') {
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
 *
 * @param installation - The installation to write to
 * @param content - The modified JavaScript content
 */
export async function writeContent(
  installation: Installation,
  content: string
): Promise<void> {
  if (installation.kind === 'native') {
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
 * Independently patchable sources of one installation, in stable order.
 * `write` takes the full array (same order and length) and persists only the
 * sources that differ from what was read.
 */
export interface ContentSources {
  sources: readonly { label: string; content: string }[];
  write(modified: readonly string[]): Promise<void>;
}

/**
 * Read every patchable source of an installation.
 *
 * Code-split native builds (Claude Code >= 2.1.229) keep only an import stub in
 * the entrypoint, so text edits must search each JavaScript and text-loader
 * module separately; concatenating them would let a match span two modules.
 * Falls back to the single legacy entrypoint when the module graph is
 * unreadable, and to cli.js for npm installs.
 */
export async function readContentSources(
  installation: Installation
): Promise<ContentSources> {
  const corpus =
    installation.kind === 'native'
      ? await extractClaudeJsModulesFromNativeInstallation(installation.path)
      : null;
  if (!corpus) {
    const content = await readContent(installation);
    return {
      sources: [{ label: installation.path, content }],
      write: async ([modified]) => {
        if (modified !== content) await writeContent(installation, modified);
      },
    };
  }

  const modules = corpus.modules.filter(
    module => module.isJavaScript || module.loader === BUN_TEXT_LOADER
  );
  const originals = modules.map(decodeNativeModuleSource);
  return {
    sources: modules.map((module, i) => ({
      label: module.name,
      content: originals[i],
    })),
    write: async modified => {
      if (modified.length !== modules.length) {
        throw new Error('Modified sources do not match the extracted modules');
      }
      const edits: BunModuleReplacement[] = modules.flatMap((module, i) =>
        modified[i] === originals[i]
          ? []
          : [
              {
                index: module.index,
                name: module.name,
                contents: Buffer.from(modified[i], 'utf8'),
              },
            ]
      );
      if (!edits.length) return;
      await repackNativeInstallationModules(
        installation.path,
        { sourceSha256: corpus.sourceSha256, modules: edits },
        installation.path
      );
    },
  };
}
