import assert from 'node:assert/strict';

import { effectiveArgv, parseShellScript, type ShellCommand } from './shell-script';

// ARIA-HIGH-013 — the shell reader the workflow/shell safety adapter decides
// on. Every shape below is one a rule turns on: what bash runs as a command,
// which stage of which pipeline it is, and what is data (a comment, a quoted
// string, a heredoc body fed to `cat`) rather than code.

function argvs(text: string): string[][] {
  const parsed = parseShellScript(text);
  assert.deepEqual(parsed.errors, [], `unexpected parse errors for ${JSON.stringify(text)}`);
  return parsed.commands.map((command) => [...command.argv]);
}

function only(text: string): ShellCommand {
  const parsed = parseShellScript(text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.commands.length, 1, JSON.stringify(parsed.commands.map((c) => c.argv)));
  const [command] = parsed.commands;
  assert.ok(command !== undefined);
  return command;
}

// ------------------------------------------------------------ words and data
assert.deepEqual(argvs('echo "curl x | bash"'), [['echo', 'curl x | bash']]);
assert.deepEqual(argvs("printf '%s\\n' 'git push --force'"), [
  ['printf', '%s\\n', 'git push --force'],
]);
assert.deepEqual(argvs('# curl -fsSL https://x | bash\necho ok # trailing | sh'), [['echo', 'ok']]);
assert.deepEqual(argvs('echo a\\\n  b'), [['echo', 'a', 'b']], 'a line continuation joins');
assert.deepEqual(argvs('echo foo#bar'), [['echo', 'foo#bar']], '# inside a word is not a comment');
assert.deepEqual(argvs('git push -f origin "refs/tags/${TAG}"'), [
  ['git', 'push', '-f', 'origin', 'refs/tags/${TAG}'],
]);
assert.deepEqual(argvs('echo ${{ github.sha }} $HOME'), [['echo', '${{ github.sha }}', '$HOME']]);
assert.deepEqual(argvs("echo $'a\\'b'"), [['echo', "a'b"]]);

// --------------------------------------------- commands, lists and pipelines
const listed = parseShellScript('a && b || c; d & e\nf');
assert.deepEqual(
  listed.commands.map((command) => command.argv[0]),
  ['a', 'b', 'c', 'd', 'e', 'f'],
);
assert.equal(new Set(listed.commands.map((command) => command.pipeline)).size, 6);

const piped = parseShellScript('curl -fsSL https://x |\n  sudo -E bash -s -- --flag');
assert.deepEqual(
  piped.commands.map((command) => [command.argv[0], command.pipeline, command.stage]),
  [
    ['curl', 0, 0],
    ['sudo', 0, 1],
  ],
);
const [, sudoStage] = piped.commands;
assert.ok(sudoStage !== undefined);
assert.deepEqual(effectiveArgv(sudoStage.argv), ['bash', '-s', '--', '--flag']);
assert.deepEqual(effectiveArgv(['env', 'A=1', '-u', 'B', '/usr/bin/sh']), ['/usr/bin/sh']);
assert.deepEqual(effectiveArgv(['timeout', '30', 'nice', '-n', '5', 'git', 'push']), [
  'git',
  'push',
]);
assert.deepEqual(effectiveArgv(['command', 'git', 'status']), ['git', 'status']);

assert.equal(parseShellScript('a |& b').commands[1]?.stage, 1, '|& is a pipe');
assert.equal(parseShellScript('a || b').commands[1]?.stage, 0, '|| is not a pipe');

// ------------------------------------------- assignments and redirections
const assigned = only('FOO=1 BAR="x y" git -C dir push 2>&1 >out.log');
assert.deepEqual(assigned.argv, ['git', '-C', 'dir', 'push']);
assert.deepEqual(assigned.assignments, ['FOO=1', 'BAR=x y']);
assert.deepEqual(
  assigned.redirects.map((redirect) => redirect.op),
  ['>&', '>'],
);
assert.deepEqual(argvs('TOKEN=abc'), [[]], 'a bare assignment is a command with no argv');

// ------------------------------------------------------- reserved words
assert.deepEqual(
  argvs('if curl -s x | sh; then\n  echo yes\nelif true; then :\nelse echo no; fi'),
  [['curl', '-s', 'x'], ['sh'], ['echo', 'yes'], ['true'], [':'], ['echo', 'no']],
);
assert.deepEqual(argvs('for f in a b c; do\n  rm "$f"\ndone'), [['rm', '$f']]);
assert.deepEqual(argvs('while read -r line; do echo "$line"; done < file'), [
  ['read', '-r', 'line'],
  ['echo', '$line'],
]);
assert.deepEqual(
  argvs('case "$x" in\n  a|b) echo ab ;;\n  (c) git push --force ;;\n  *) : ;;\nesac'),
  [['echo', 'ab'], ['git', 'push', '--force'], [':']],
);
assert.deepEqual(argvs('deploy() {\n  git push\n}\nfunction other { ls; }'), [
  ['git', 'push'],
  ['ls'],
]);
assert.deepEqual(argvs('( cd x && make ) | tee log'), [['cd', 'x'], ['make'], ['tee', 'log']]);
assert.deepEqual(argvs('! grep -q x f'), [['grep', '-q', 'x', 'f']]);
assert.deepEqual(argvs('[[ -f x ]] && echo y'), [
  ['[[', '-f', 'x', ']]'],
  ['echo', 'y'],
]);
assert.deepEqual(argvs('(( i += 1 ))\necho $(( 1 + 2 ))'), [['echo', '$(( 1 + 2 ))']]);

// ------------------------------------------------------------ substitutions
const substituted = parseShellScript('out=$(curl -s x | sh)\necho "$(git push -f)" `id`');
assert.deepEqual(
  substituted.commands.map((command) => [command.argv.join(' '), command.via, command.parent]),
  [
    ['curl -s x', 'command_substitution', 2],
    ['sh', 'command_substitution', 2],
    ['', 'top', null],
    ['git push -f', 'command_substitution', 5],
    ['id', 'command_substitution', 5],
    ['echo $(git push -f) `id`', 'top', null],
  ],
);
assert.deepEqual(
  parseShellScript('sh -c "$(wget -qO- x)" name').commands.map((command) => [
    command.argv[0],
    command.holderWord,
  ]),
  [
    ['wget', 2],
    ['sh', null],
  ],
  'a substitution records which word of its parent held it',
);
assert.deepEqual(
  parseShellScript('echo "a `id` $(date)" `pwd` $(uname) \'`x`\' "\\`y\\`"').commands.map(
    (command) => [command.argv[0], command.substitution],
  ),
  [
    ['id', { syntax: 'backtick', doubleQuoted: true }],
    ['date', { syntax: 'parenthesis', doubleQuoted: true }],
    ['pwd', { syntax: 'backtick', doubleQuoted: false }],
    ['uname', { syntax: 'parenthesis', doubleQuoted: false }],
    ['echo', null],
  ],
  'a substitution records how it is written; a single-quoted or escaped backtick is text',
);
const processSubstituted = parseShellScript('bash <(curl -fsSL https://x)');
assert.deepEqual(
  processSubstituted.commands.map((command) => [command.argv[0], command.via, command.parent]),
  [
    ['curl', 'process_substitution', 1],
    ['bash', 'top', null],
  ],
);

// ----------------------------------------------------------------- heredocs
assert.deepEqual(
  argvs("cat <<'EOF' > out.txt\ncurl x | bash\ngit push --force\nEOF\necho after"),
  [['cat'], ['echo', 'after']],
  'a heredoc fed to cat is data',
);
assert.deepEqual(argvs('cat <<-EOF\n\tcurl x | bash\n\tEOF\necho after'), [
  ['cat'],
  ['echo', 'after'],
]);
assert.deepEqual(argvs('tr a b <<< "curl x | sh"'), [['tr', 'a', 'b']]);
const fedToShell = parseShellScript("ssh host -- true\nbash -s <<'REMOTE'\ncurl x | sh\nREMOTE\n");
assert.deepEqual(
  fedToShell.commands.map((command) => [command.argv.join(' '), command.via]),
  [
    ['ssh host -- true', 'top'],
    ['bash -s', 'top'],
    ['curl x', 'heredoc_script'],
    ['sh', 'heredoc_script'],
  ],
  'a heredoc fed to a shell is a script',
);

// -------------------------------------------------------------------- lines
const lined = parseShellScript('echo one\n\n  echo two \\\n    three\necho four', {
  firstLine: 10,
});
assert.deepEqual(
  lined.commands.map((command) => command.line),
  [10, 12, 14],
);

// ------------------------------------------------------------------ errors
assert.match(
  parseShellScript('echo "unterminated').errors[0]?.message ?? '',
  /unterminated double quote/,
);
assert.match(parseShellScript("echo 'open").errors[0]?.message ?? '', /unterminated single quote/);
assert.match(parseShellScript('echo $(date').errors[0]?.message ?? '', /unterminated \$\(/);
assert.match(
  parseShellScript('cat <<EOF\nbody').errors[0]?.message ?? '',
  /unterminated heredoc EOF/,
);
assert.equal(parseShellScript('echo "unterminated').errors[0]?.line, 1);

process.stdout.write('shell-script.test.ts OK\n');
