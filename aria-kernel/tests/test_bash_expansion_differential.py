"""The Bash gate's contract, measured against bash itself.

ARIA-CRITICAL-446 (glued operators), ARIA-HIGH-443 (a line break, then the
line break Python's ``str.rstrip`` hid) and ARIA-HIGH-505 (words bash expands:
braces, parameters, globs, tilde, backslash-newline) are four instances of one
missing contract. The gate judges the argv ``shlex.split`` lexes from a line;
bash runs the argv IT builds from the same line; nothing checked that the two
agree, and every earlier test pinned a hand-picked list of strings.

The contract, stated by ``command_policy.unmodelled_shell_syntax``: a line it
admits (returns None for) is one whose ``shlex.split`` argv is the argv bash
runs. The one tolerated difference is a comment: bash drops an unquoted
``#``-word and the rest of its line, ``shlex`` keeps them, so the gate sees
MORE words than bash runs, never fewer or different ones.

How it is measured: one ``bash --norc --noprofile`` process per locale (the
byte locale and a UTF-8 one) reads every line NUL-separated and ``eval``s it
as ``f <word>``, where ``f`` prints a start mark and its arguments. Its PATH
is an empty directory (no corpus word can reach a program), its working
directory holds files a glob can match, and HOME is fixed so a tilde has
something to expand to. The corpus is every word of length <= 3 over an
alphabet of the characters that matter to either lexer, a seeded random
sample of longer words, and one witness per scanner rule.
"""
from __future__ import annotations

import itertools
import random
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.command_policy import (  # noqa: E402
    ANSI_C_QUOTE,
    EXPANSION_MARKERS,
    unmodelled_shell_syntax,
)

# Everything either lexer treats specially, plus the whitespace the two
# disagree on (ARIA-HIGH-443: \x0b, \xa0, U+2028, \r) and `!` (history
# expansion is off in a non-interactive bash, so it stays a word character).
ALPHABET: tuple[str, ...] = (
    "a", "-", ",", ".", "{", "}", "*", "?", "[", "]", "~", "$", "=", ":", "'", '"', "\\", "`",
    " ", "\n", "\t", "\x0b", "\xa0", "\u2028", "#", "\r", "!",
)
EXHAUSTIVE_LENGTH = 3
RANDOM_WORDS = 3000
RANDOM_SEED = 20261014
# Files the glob classes can match, and a HOME for the tilde class.
GLOB_FILES: tuple[str, ...] = ("a", "aa", "-a", ",a", "a.a", "a,a", "~a")
HOME = "/h"
# Bash's lexer treats quote, escape and break bytes as special only outside a
# multibyte character, so what it runs depends on the locale; the rooms
# inherit the kernel's (LANG / LC_ALL / LC_CTYPE), so both the byte locale and
# a UTF-8 one are measured. A locale the host lacks is reported as skipped.
LOCALES: tuple[str, ...] = ("C", "C.UTF-8")
# One line per scanner RULE (not per marker: the unquoted and the
# double-quoted `$` are two branches of the scanner returning one marker) on
# which bash and shlex disagree, so every branch is shown to be load-bearing
# whatever the random sample holds: (rule, marker it returns, line).
WITNESSES: tuple[tuple[str, str, str], ...] = (
    ("line break", "\n", "f a\na"),
    ("carriage return", "\r", "f a\r"),
    ("parameter expansion, unquoted", "$", "f a$IFS-a"),
    ("parameter expansion, double-quoted", "$", 'f "$HOME"'),
    ("ANSI-C quoting", ANSI_C_QUOTE, "f $'a'"),
    ("command substitution, unquoted", "`", "f `printf a`"),
    ("command substitution, double-quoted", "`", 'f "`printf a`"'),
    ("pathname expansion *", "*", "f *"),
    ("pathname expansion ?", "?", "f ?"),
    ("pathname expansion [", "[", "f [a]"),
    ("tilde prefix", "~", "f ~"),
    ("brace expansion", "{,}", "f {a,b}"),
    ("line continuation, unquoted", "\\\n", "f a\\\na"),
    ("line continuation, double-quoted", "\\\n", 'f "a\\\nb"'),
    ("escaped $ in double quotes", "\\$", 'f "a\\$"'),
    ("escaped backtick in double quotes", "\\`", 'f "a\\`"'),
)
WITNESS_LINES: frozenset[str] = frozenset(line for _, _, line in WITNESSES)
WITNESS_MARKERS: frozenset[str] = frozenset(marker for _, marker, _ in WITNESSES)

# Lines a short random corpus is unlikely to hold, each a shape one of the
# lexers once got wrong: bash's brace search passing a `}` that closes no
# expression (`{a},b}` expands to `a}` and `b`), git's revision braces, and the
# tilde and quote-removal corners.
CURATED: tuple[str, ...] = (
    "f {a},b}", "f x{a},}", "f \\.{a]]\x0b\xa0},}", "f {a{b}c,d}", "f {},a}", "f {a..b}", "f a{,}",
    "f HEAD@{1}..HEAD@{2}", "f @{u}..HEAD", "f HEAD^{tree}", "f stash@{0}", "f --format=%H{x}",
    "f HEAD@{1} a,b}",  # a word's braces end with it: the next word's `,` and `}` are literal
    'f a"="~', 'f ""~', "f a=~", "f x=a:~", "f --x=~", "f a:~", "f HEAD~1",
    'f "a\\b"', "f 'a\\$'", 'f "\\""', "f !a", "f a!", "f a#b", "f a # b",
)

_START, _ARG_END, _RECORD_END = "\x1d", "\x1f", "\x1e"
_BASH_DRIVER = (
    "f() { printf '\\035'; for x in \"$@\"; do printf '%s\\037' \"$x\"; done; }\n"
    "while IFS= read -r -d '' line; do eval \"$line\" 2>/dev/null; printf '\\036'; done\n"
)


def _corpus() -> list[str]:
    words: set[str] = set()
    for length in range(1, EXHAUSTIVE_LENGTH + 1):
        words.update("".join(chars) for chars in itertools.product(ALPHABET, repeat=length))
    rng = random.Random(RANDOM_SEED)
    for _ in range(RANDOM_WORDS):
        words.add("".join(rng.choice(ALPHABET) for _ in range(rng.randint(5, 12))))
    return ["f " + word for word in sorted(words)] + sorted(WITNESS_LINES) + list(CURATED)


def _locale_is_installed(bash: str, locale: str) -> bool:
    """Whether bash can switch to ``locale`` (it warns on stderr when not)."""
    done = subprocess.run(
        [bash, "--norc", "--noprofile", "-c", ":"], capture_output=True, check=False, timeout=30,
        env={"PATH": "/nonexistent", "LC_ALL": locale},
    )
    return done.returncode == 0 and b"setlocale" not in done.stderr


def _bash_argvs(bash: str, lines: list[str], locale: str) -> list[list[str] | None]:
    """The argv bash hands ``f`` for each line under ``locale``, or None when
    ``f`` never ran (a bash syntax error: nothing executes)."""
    with tempfile.TemporaryDirectory() as work:
        empty_path = Path(work) / "empty-path"
        empty_path.mkdir()
        cwd = Path(work) / "cwd"
        cwd.mkdir()
        for name in GLOB_FILES:
            (cwd / name).touch()
        payload = "".join(line + "\0" for line in lines).encode("utf-8")
        done = subprocess.run(
            [bash, "--norc", "--noprofile", "-c", _BASH_DRIVER],
            input=payload, cwd=cwd, capture_output=True, check=False, timeout=300,
            env={"PATH": str(empty_path), "HOME": HOME, "LC_ALL": locale},
        )
    records = done.stdout.decode("utf-8", "surrogateescape").split(_RECORD_END)
    if len(records) < len(lines):
        raise AssertionError(f"bash answered {len(records)} of {len(lines)} lines: {done.stderr[-500:]!r}")
    return [
        record[1:].split(_ARG_END)[:-1] if record.startswith(_START) else None
        for record in records[:len(lines)]
    ]


class AdmittedLinesAreLexedAsBashRunsThem(unittest.TestCase):
    """ARIA-HIGH-505 — the contract every admitted line meets, on bash itself."""

    @classmethod
    def setUpClass(cls) -> None:
        bash = shutil.which("bash")
        if bash is None:
            raise unittest.SkipTest("bash is not installed")
        cls.admitted: list[tuple[str, list[str]]] = []
        cls.refused: dict[str, list[tuple[str, list[str]]]] = {}
        for line in _corpus():
            try:
                argv = shlex.split(line)[1:]
            except ValueError:
                argv = None
            marker = unmodelled_shell_syntax(line)
            if marker is not None:
                if argv is not None:
                    cls.refused.setdefault(marker, []).append((line, argv))
            elif argv is not None:
                cls.admitted.append((line, argv))
        # Admitted lines first, then a bounded sample of each refused class.
        sample = [case for cases in cls.refused.values() for case in cases[:400]]
        always = WITNESS_LINES | set(CURATED)
        sample += [case for cases in cls.refused.values() for case in cases[400:] if case[0] in always]
        cases = cls.admitted + sample
        cls.shlex_of = dict(cases)
        cls.locales = tuple(locale for locale in LOCALES if _locale_is_installed(bash, locale))
        cls.bash_of: dict[str, dict[str, list[str] | None]] = {}
        for locale in cls.locales:
            argvs = _bash_argvs(bash, [line for line, _ in cases], locale)
            cls.bash_of[locale] = {line: argv for (line, _), argv in zip(cases, argvs)}

    def test_the_corpus_reaches_every_class_and_admits_enough_to_mean_something(self) -> None:
        self.assertGreater(len(self.admitted), 5000)
        for marker in WITNESS_MARKERS:
            self.assertIn(marker, self.refused, f"no corpus line is refused as {marker!r}")

    def test_every_locale_is_measured(self) -> None:
        self.assertIn("C", self.locales)
        for locale in LOCALES:
            with self.subTest(locale=locale):
                if locale not in self.locales:
                    self.skipTest(f"locale {locale} is not installed")

    def test_admitted_lines_are_lexed_as_bash_runs_them(self) -> None:
        for locale in self.locales:
            mismatches = []
            for line, argv in self.admitted:
                ran = self.bash_of[locale][line]
                if ran is None or ran == argv:
                    continue  # a bash syntax error runs nothing
                if "#" in line and argv[:len(ran)] == ran:
                    continue  # bash dropped a comment the gate still judges: the gate sees more
                mismatches.append({"line": line, "shlex": argv, "bash": ran})
            with self.subTest(locale=locale):
                self.assertEqual(mismatches[:20], [], f"{len(mismatches)} admitted lines run a different argv")

    def test_every_refusal_rule_is_load_bearing(self) -> None:
        """Each branch of the scanner refuses its witness, on which bash's argv
        is not shlex's: no refusal is there by superstition."""
        for rule, marker, line in WITNESSES:
            with self.subTest(rule=rule):
                self.assertEqual(unmodelled_shell_syntax(line), marker)
                for locale in self.locales:
                    ran = self.bash_of[locale][line]
                    self.assertIsNotNone(ran, f"{locale}: bash refused to run the witness {line!r}")
                    self.assertNotEqual(ran, self.shlex_of[line], f"{locale}: bash and shlex agree on {line!r}")

    def test_every_expansion_marker_has_a_witness(self) -> None:
        self.assertEqual(set(EXPANSION_MARKERS) - WITNESS_MARKERS, set())


class TheExpansionBypassIsRealInGit(unittest.TestCase):
    """Why the refusal exists, on real git: a brace word turns a message into
    an option the commit grammar refuses when it is spelled out. Not a test of
    the gate (the gate never runs here); a pin of the threat."""

    def test_a_brace_word_skips_the_pre_commit_hook(self) -> None:
        bash, git = shutil.which("bash"), shutil.which("git")
        if bash is None or git is None:
            self.skipTest("bash and git are both required")
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            env = {
                "PATH": str(Path(git).parent) + ":/usr/bin:/bin", "HOME": tmp, "LC_ALL": "C",
                "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
            }

            def run(*argv: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(list(argv), cwd=repo, env=env, capture_output=True, text=True,
                                      check=False, timeout=60)

            run(git, "init", "-q")
            run(git, "config", "user.name", "t")
            run(git, "config", "user.email", "t@example.invalid")
            run(git, "config", "commit.gpgsign", "false")
            (repo / "f").write_text("1\n", encoding="utf-8")
            run(git, "add", "f")
            self.assertEqual(run(git, "commit", "-q", "-m", "first").returncode, 0)
            hook = repo / ".git" / "hooks" / "pre-commit"
            hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            hook.chmod(0o700)
            (repo / "f").write_text("2\n", encoding="utf-8")
            run(git, "add", "f")

            refused = run(bash, "--norc", "--noprofile", "-c", "git commit -q -m second")
            self.assertNotEqual(refused.returncode, 0, "the hook did not refuse the plain commit")
            expanded = run(bash, "--norc", "--noprofile", "-c", "git commit -q -m {second,-n}")
            self.assertEqual(expanded.returncode, 0, expanded.stderr)
            self.assertEqual(run(git, "log", "-1", "--format=%s").stdout.strip(), "second")


if __name__ == "__main__":
    unittest.main()
