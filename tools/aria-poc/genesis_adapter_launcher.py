"""ARIA-HIGH-414 — the kernel launcher every skill-genesis drafted adapter runs under.

WHY: the drafted adapter's import allowlist (``skill_genesis_sandbox``) was a
static AST walk over ``import`` statements, and Python reaches a module by
many other spellings: ``__import__('subprocess')``, ``sys.modules['os']``,
``exec`` of a string, ``getattr(builtins, '__im' + 'port__')``, a generator's
``gi_frame.f_builtins``, ``functools.singledispatch`` evaluating a string
annotation, and ``import os.path`` (allowed as written) binding ``os``. No
name-based deny can be complete, so the allowlist is enforced where every
spelling converges: the interpreter's own import machinery and audit events,
in the room (``adapter_room``), before the adapter's first byte compiles.

WHAT, in order (kernel code; the adapter arrives as DATA on stdin):

1. Read one header line — ``{"source": <text>, "allowed_imports": [...]}`` —
   and refuse unless sha256(source) equals the digest on the command line
   (the one the kernel recorded in custody).
2. Drop the script directory and site-/dist-packages from ``sys.path`` so a
   repository file cannot shadow a standard-library name, then import the
   allowlist (and the private stdlib helper ``_strptime``, which
   ``datetime.strptime`` loads lazily). That is the whole set of modules the
   adapter will ever have.
3. Remove ``_imp``'s native-module constructors. ``create_builtin`` raises no
   audit event, and this interpreter builds ``_posixsubprocess`` and
   ``_socket`` in (measured, Ubuntu python3.12), so without this a builtin
   module could be instantiated past the hook.
4. Install an audit hook (PEP 578: it cannot be removed) that refuses every
   further module load, process creation, thread start, tracing/monitoring,
   a second hook, re-pointing any function's ``__code__`` (the hook itself is
   reachable through frames), and opening any file for writing: an adapter
   is a read-only scanner, and a writable ``/proc/self/mem`` would let it
   patch the interpreter past this hook. Its conditions read only literals
   and the interpreter's own arguments, so rebinding a builtin cannot turn a
   refusal into a pass.
5. Compile the verified bytes and run them as ``__main__``; the rest of stdin
   is the adapter's own input.

The room remains the OS boundary (no network, read-only workspace, no
secrets, private PID namespace); this launcher makes the allowlist hold
inside it. Exit 97 with ``genesis_launcher_refused:<reason>`` on stderr means
the adapter never started.
"""
import sys

_REFUSED_EXIT = 97
# Loaded lazily by allowlisted APIs (``datetime.strptime``); preloaded here
# because no module may load once the adapter runs.
_LAZY_STDLIB_HELPERS = ("_strptime",)
# The native-module constructors of the import machinery: after the
# allowlist is loaded nothing may build a C module again.
_NATIVE_CONSTRUCTORS = ("create_builtin", "exec_builtin", "create_dynamic", "exec_dynamic")


def _refuse(reason):
    sys.stderr.write("genesis_launcher_refused:" + reason + "\n")
    return _REFUSED_EXIT


def _audit(event, args):
    # Literals only (see the module docstring, step 4).
    if event == "import":
        raise ImportError("genesis_adapter_import_refused:" + str(args[0]))
    if event == "object.__setattr__" and args[1] == "__code__":
        raise PermissionError("genesis_adapter_capability_refused:function.__code__")
    # O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND: the interpreter passes
    # the open flags as a plain int for open(), io.FileIO and os.open alike.
    if event == "open" and args[2] & 0o3103:
        raise PermissionError("genesis_adapter_capability_refused:open_for_write")
    if event.startswith((
        "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty",
        "os.kill", "os.killpg", "subprocess.", "ctypes.", "socket.", "_thread.start_new_thread",
        "sys.addaudithook", "sys.settrace", "sys.setprofile", "sys.monitoring",
    )):
        raise PermissionError("genesis_adapter_capability_refused:" + event)


def main():
    if len(sys.argv) != 2:
        return _refuse("usage: genesis_adapter_launcher.py <sha256>")
    expected = sys.argv[1]
    script_dir = sys.path[0]
    sys.path[:] = [
        entry for entry in sys.path[1:]
        if entry != script_dir and "site-packages" not in entry and "dist-packages" not in entry
    ]
    import hashlib
    import json

    try:
        header = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
        source = header["source"]
        allowed = header["allowed_imports"]
    except (ValueError, KeyError, TypeError):
        return _refuse("header_unreadable")
    if not isinstance(source, str) or not isinstance(allowed, list):
        return _refuse("header_unreadable")
    if hashlib.sha256(source.encode("utf-8")).hexdigest() != expected:
        return _refuse("source_digest_mismatch")
    for name in [*allowed, *_LAZY_STDLIB_HELPERS]:
        __import__(str(name))
    machinery = sys.modules["_imp"]
    for constructor in _NATIVE_CONSTRUCTORS:
        if hasattr(machinery, constructor):
            delattr(machinery, constructor)
    sys.addaudithook(_audit)
    code = compile(source, "<genesis-adapter " + expected[:12] + ">", "exec", dont_inherit=True)
    sys.argv = ["genesis-adapter"]
    exec(code, {"__name__": "__main__"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
