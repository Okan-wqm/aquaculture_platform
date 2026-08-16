"""Fixture CLI: one routed verb (FP trap) and one registered-but-dead verb (TP)."""


def build_parser(sub):
    # TRAP: registered AND routed below — must not be flagged.
    add_subparser(sub, "promote")
    # TRUE POSITIVE: registered and dispatched by nothing.
    add_subparser(sub, "reconcile")


def _main(args):
    if args.command == "promote":
        return 0
    return 1
