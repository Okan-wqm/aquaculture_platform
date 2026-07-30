// Jest loads TypeScript config files before the repository transformer is
// available, so this CommonJS facade exposes the canonical JSON floors.
module.exports = Object.freeze(require('./service-coverage-baselines.json'));
