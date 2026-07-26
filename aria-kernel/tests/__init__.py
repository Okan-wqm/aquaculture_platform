"""Tests for the ARIA governance kernel.

Importing this package installs the hermetic git environment before any
test module runs, so no fixture repository — factory-built or created
inline with a bare ``git init`` — can inherit the machine's global git
configuration. See ``tests/_helpers/hermetic_git.py`` for why.
"""

from tests._helpers.hermetic_git import apply_hermetic_git_env

apply_hermetic_git_env()
