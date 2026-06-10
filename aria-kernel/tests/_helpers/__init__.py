"""Test helpers (NON-test code; excluded from unittest discovery).

The directory name starts with ``_`` so the ``unittest discover -p '*test*.py'``
glob (used in CI) does not descend into it. Files inside are utility
modules imported by tests, never executed as tests themselves.
"""
