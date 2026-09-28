import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedBunModule } from '../nativeInstallation';
import {
  extractClaudeJsFromNativeInstallation,
  extractClaudeJsModulesFromNativeInstallation,
  repackNativeInstallation,
  repackNativeInstallationModules,
} from '../nativeInstallationLoader';
import { readContentSources } from './content';

vi.mock('../nativeInstallationLoader', () => ({
  extractClaudeJsFromNativeInstallation: vi.fn(),
  extractClaudeJsModulesFromNativeInstallation: vi.fn(),
  repackNativeInstallation: vi.fn(),
  repackNativeInstallationModules: vi.fn(),
}));

const native = {
  kind: 'native',
  path: '/bin/claude',
  version: '2.1.282',
} as const;

function mod(
  index: number,
  name: string,
  contents: string,
  overrides: Partial<ExtractedBunModule> = {}
): ExtractedBunModule {
  return {
    index,
    name,
    contents: Buffer.from(contents, 'latin1'),
    loader: 1,
    moduleFormat: 1,
    encoding: 1,
    side: 0,
    isEntrypoint: false,
    isJavaScript: true,
    ...overrides,
  };
}

// A code-split graph: the entrypoint only imports the chunk holding the prompt.
const corpus = {
  sourceSha256: 'digest-of-original',
  moduleStructSize: 52 as const,
  entryPointId: 1,
  modules: [
    mod(0, '/$bunfs/root/chunk-a.js', 'const p="Be concise.";export{p};'),
    mod(1, '/$bunfs/root/cli', 'import"./chunk-a.js";', { isEntrypoint: true }),
    mod(2, '/$bunfs/root/addon.node', 'Be concise.', {
      loader: 5,
      isJavaScript: false,
    }),
    mod(3, '/$bunfs/root/prompt.md', '# Be concise.', {
      loader: 13,
      isJavaScript: false,
    }),
  ],
};

describe('readContentSources', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes JavaScript and text-loader modules but never binary assets', async () => {
    vi.mocked(extractClaudeJsModulesFromNativeInstallation).mockResolvedValue(
      corpus
    );
    const { sources } = await readContentSources(native);
    expect(sources.map(source => source.label)).toEqual([
      '/$bunfs/root/chunk-a.js',
      '/$bunfs/root/cli',
      '/$bunfs/root/prompt.md',
    ]);
  });

  it('writes only changed modules, pinned to the extracted digest', async () => {
    vi.mocked(extractClaudeJsModulesFromNativeInstallation).mockResolvedValue(
      corpus
    );
    const { sources, write } = await readContentSources(native);
    await write(
      sources.map(source => source.content.replace('Be concise.', 'Be brief.'))
    );
    expect(repackNativeInstallationModules).toHaveBeenCalledWith(
      '/bin/claude',
      {
        sourceSha256: 'digest-of-original',
        modules: [
          {
            index: 0,
            name: '/$bunfs/root/chunk-a.js',
            contents: Buffer.from('const p="Be brief.";export{p};'),
          },
          {
            index: 3,
            name: '/$bunfs/root/prompt.md',
            contents: Buffer.from('# Be brief.'),
          },
        ],
      },
      '/bin/claude'
    );
    expect(repackNativeInstallation).not.toHaveBeenCalled();
  });

  it('does not repack when nothing changed', async () => {
    vi.mocked(extractClaudeJsModulesFromNativeInstallation).mockResolvedValue(
      corpus
    );
    const { sources, write } = await readContentSources(native);
    await write(sources.map(source => source.content));
    expect(repackNativeInstallationModules).not.toHaveBeenCalled();
  });

  it('rejects a modified array that does not line up with the modules', async () => {
    vi.mocked(extractClaudeJsModulesFromNativeInstallation).mockResolvedValue(
      corpus
    );
    const { write } = await readContentSources(native);
    await expect(write(['only one'])).rejects.toThrow(
      'Modified sources do not match the extracted modules'
    );
  });

  it('falls back to the legacy entrypoint when the module graph is unreadable', async () => {
    vi.mocked(extractClaudeJsModulesFromNativeInstallation).mockResolvedValue(
      null
    );
    vi.mocked(extractClaudeJsFromNativeInstallation).mockResolvedValue(
      Buffer.from('legacy bundle')
    );
    const { sources, write } = await readContentSources(native);
    expect(sources).toEqual([
      { label: '/bin/claude', content: 'legacy bundle' },
    ]);
    await write(['patched bundle']);
    expect(repackNativeInstallation).toHaveBeenCalledWith(
      '/bin/claude',
      Buffer.from('patched bundle'),
      '/bin/claude'
    );
  });
});
