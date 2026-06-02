const { createProjectGraphAsync } = require('@nx/devkit');
const { existsSync } = require('fs');
const { join, parse } = require('path');
const yargsParserImport = require('yargs-parser');

const yargsParser =
  typeof yargsParserImport === 'function'
    ? yargsParserImport
    : yargsParserImport.default ?? yargsParserImport;

function projectPath(path) {
  return join('<rootDir>', path);
}

function collectJestExecutor(target, projects) {
  if (target.options?.jestConfig) {
    projects.add(projectPath(target.options.jestConfig));
  }
  for (const configuration of Object.values(target.configurations ?? {})) {
    if (configuration.jestConfig) {
      projects.add(projectPath(configuration.jestConfig));
    }
  }
}

function collectCommand(command, cwd, projects) {
  const jestCommandRegex = /(?<=^|&)(?:[^&\r\n\s]* )*jest(?: [^&\r\n\s]*)*(?=$|&)/g;
  const matches = command.match(jestCommandRegex);
  if (!matches) return;

  for (const match of matches) {
    const parsed = yargsParser(match, {
      configuration: { 'strip-dashed': true },
      string: ['config'],
    });
    if (!parsed.config) {
      projects.add(projectPath(cwd));
      continue;
    }
    const configFromRoot = join(__dirname, parsed.config);
    const configPath = existsSync(configFromRoot) ? parsed.config : join(cwd, parsed.config);
    projects.add(projectPath(configPath));
  }
}

function collectRunCommands(target, projectRoot, projects) {
  if (target.options?.command) {
    collectCommand(target.options.command, target.options.cwd ?? projectRoot, projects);
  }
  for (const command of target.options?.commands ?? []) {
    collectCommand(typeof command === 'string' ? command : command.command, target.options.cwd ?? projectRoot, projects);
  }
  for (const configuration of Object.values(target.configurations ?? {})) {
    if (configuration.command) {
      collectCommand(configuration.command, configuration.cwd ?? projectRoot, projects);
    }
    for (const command of configuration.commands ?? []) {
      collectCommand(
        typeof command === 'string' ? command : command.command,
        configuration.cwd ?? projectRoot,
        projects,
      );
    }
  }
}

async function getJestProjectsStable() {
  const graph = await createProjectGraphAsync({
    exitOnError: false,
    resetDaemonClient: true,
  });
  const projects = new Set();

  for (const node of Object.values(graph.nodes)) {
    const projectConfig = node.data;
    for (const target of Object.values(projectConfig.targets ?? {})) {
      if (target.executor === '@nx/jest:jest' || target.executor === '@nrwl/jest:jest') {
        collectJestExecutor(target, projects);
      } else if (target.executor === 'nx:run-commands') {
        collectRunCommands(target, projectConfig.root, projects);
      }
    }
  }

  projects.forEach((config) => {
    const { dir, ext } = parse(config);
    if (ext) projects.delete(dir);
  });
  return [...projects];
}

function directInvariantConfig() {
  const invariantPaths = process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('tests/invariants/') && arg.endsWith('.ts'));
  if (invariantPaths.length === 0) return null;

  return {
    rootDir: __dirname,
    moduleFileExtensions: ['ts', 'js', 'html'],
    testEnvironment: 'node',
    testMatch: invariantPaths.map((path) => `<rootDir>/${path}`),
    transform: {
      '^.+\\.[tj]s$': [
        'ts-jest',
        {
          isolatedModules: true,
          tsconfig: join(__dirname, 'tests/invariants/tsconfig.spec.json'),
        },
      ],
    },
  };
}

module.exports = async () => {
  const directConfig = directInvariantConfig();
  if (directConfig) {
    return directConfig;
  }

  return {
    projects: await getJestProjectsStable(),
  };
};
