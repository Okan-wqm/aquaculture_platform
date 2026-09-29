import { assertCompletionPublicationPaths } from '../src/runtime/completion-publication-paths';

const base = {
  output_path: '/private/output/projection.json',
  bundle_path: '/private/bundle',
  checkpoint_root: '/private/checkpoints',
  current_epoch_root: '/private/epochs',
  input_paths: ['/private/input/request.json'],
} as const;

describe('completion publication path separation', () => {
  it('accepts only disjoint canonical destinations and inputs', () => {
    expect(() => assertCompletionPublicationPaths(base)).not.toThrow();
  });

  it.each([
    ['same output and bundle', { output_path: '/private/bundle' }],
    ['output below bundle', { output_path: '/private/bundle/projection.json' }],
    ['bundle below output', { bundle_path: '/private/output/projection.json/bundle' }],
    ['bundle below input', { bundle_path: '/private/input/request.json/bundle' }],
    ['input below bundle', { input_paths: ['/private/bundle/request.json'] }],
    ['input below checkpoint', { input_paths: ['/private/checkpoints/request.json'] }],
    ['checkpoint below input', { checkpoint_root: '/private/input/request.json/checkpoints' }],
    ['input below epoch root', { input_paths: ['/private/epochs/current.json'] }],
    [
      'output below the repository input root',
      {
        output_path: '/private/repository/.git/refs/heads/aria-output',
        input_paths: ['/private/repository'],
      },
    ],
  ] as const)('rejects %s', (_label, override) => {
    expect(() => assertCompletionPublicationPaths({ ...base, ...override })).toThrow(/overlap/i);
  });
});
