"""DET crossfile-1 (Z41 a) - the PoC's SQL enum corpus sees what the migrator runs.

Root cause (DET-RCA crossfile.md 3.2 Z41, link 1): ``detect_sql_enums`` decided
two things by hand. ``SQL_ENUM_PATTERN`` read only a bare type name, so the
TypeORM baselines' ``CREATE TYPE "farm"."suppliers_status_enum" AS ENUM(...)``
(quoted, schema-qualified) was invisible, and the files it read were chosen by
the path substring ``/database/migrations/``, so ``apps/{auth,admin-api,
event-store}-service/src/migrations/`` were never read while a spec's test DDL
under ``migrations/__tests__/`` would have been. The owner of "which files are
migrations" is ``SCHEMA_REGISTRY[].migrationsGlob``
(apps/db-migrate/src/schema-registry.ts): the dirs the migrator really runs,
timestamp-prefixed files only, relative to the workspace root.

Every test below carries a positive that is invisible before the fix, so each
fails on its assertion at the old behaviour; the decoys in the same fixture are
the near-miss negatives that the exact-set assertions hold in place afterwards.
The registry fixtures use the declaration's real shape (doc header naming
``migrationsGlob`` and a glob example, single-line and multi-line arrays,
comments inside an array, an ``entitiesGlob`` beside it).
"""

from __future__ import annotations

import importlib.util
import re
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_POC_PATH = _REPO_ROOT / "tools" / "aria-poc" / "poc.py"
_SPEC = importlib.util.spec_from_file_location("aria_poc_for_test_det_crossfile1", _POC_PATH)
assert _SPEC and _SPEC.loader
aria_poc = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = aria_poc
_SPEC.loader.exec_module(aria_poc)


REGISTRY_PATH = "apps/db-migrate/src/schema-registry.ts"

# The TypeORM baseline form (farm-service 1800000000000-Baseline.ts:147): quoted
# schema, quoted type, DO-block wrapper, no space between ENUM and the list.
ANCHOR_PATH = "apps/farm-service/src/database/migrations/1800000000000-Baseline.ts"
ANCHOR_NAME = "suppliers_status_enum"
ANCHOR_VALUES = ["active", "blacklisted", "inactive", "suspended"]
ANCHOR_SQL = (
    "export class Baseline1800000000000 {\n"
    "    public async up(queryRunner: QueryRunner): Promise<void> {\n"
    "        await queryRunner.query(`DO $$ BEGIN CREATE TYPE \"farm\".\"suppliers_status_enum\" "
    "AS ENUM('active', 'inactive', 'suspended', 'blacklisted'); "
    "EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);\n"
    "    }\n"
    "}\n"
)


def _glob(directory: str) -> str:
    return f"'{directory}/[0-9]*{{.ts,.js}}'"


def _registry_source(entries: dict[str, list[str]]) -> str:
    """schema-registry.ts-shaped source: ``entries`` maps a service to the raw
    lines of its ``migrationsGlob`` array (globs, or comments)."""
    rows = []
    for service, items in entries.items():
        if len(items) == 1 and not items[0].startswith("//"):
            array = f"[{items[0]}]"
        else:
            array = "[\n" + "".join(f"      {item}\n" for item in items) + "    ]"
        extra = (
            f"    entitiesGlob: ['apps/{service}/src/**/*.entity.{{ts,js}}'],\n"
            if service == "farm-service" else ""
        )
        rows.append(
            "  {\n"
            f"    service: '{service}',\n"
            f"    schema: '{service.removesuffix('-service')}',\n"
            f"    migrationsGlob: {array},\n"
            f"{extra}"
            "    reason: 'fixture',\n"
            "  },"
        )
    return (
        "/**\n"
        " * # Why a static registry instead of auto-discovery\n"
        " * A filesystem glob walk (e.g. `apps/*\\/src/**\\/migrations/*.ts`) would look\n"
        " * simpler. # Why `migrationsGlob` (not class imports): globs MUST include\n"
        " * `[0-9]*` after `/migrations/` so only timestamped files are loaded.\n"
        " */\n"
        "export interface SchemaRegistryEntry {\n"
        "  service: string;\n  schema: string;\n  migrationsGlob: string[];\n  reason: string;\n}\n\n"
        "export const SCHEMA_REGISTRY: SchemaRegistryEntry[] = [\n"
        + "\n".join(rows)
        + "\n];\n"
    )


class _Tree:
    """A throwaway workspace: every written file is also walked and fated, as in a real run."""

    def __init__(self, root: Path, registry: dict[str, list[str]] | None = None) -> None:
        self.root = root
        self.fates: list = []
        self.write(REGISTRY_PATH, _registry_source(registry or _FARM_ONLY))

    def write(self, rel: str, text: str) -> str:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        self.fates.append(aria_poc.FileFate(rel, "read_deeply"))
        return rel

    def corpus(self) -> list[tuple[str, str]]:
        """(type name, file) for every SQL enum the scan sees, sorted."""
        enums = aria_poc.detect_sql_enums(self.root, self.fates)
        return sorted((e["name"], e["ref"].rsplit(":", 1)[0]) for e in enums)


_FARM_ONLY = {"farm-service": [_glob("apps/farm-service/src/database/migrations")]}


class SqlEnumTypeNameForms(unittest.TestCase):
    """The pattern reads the type name behind quotes and a schema qualifier."""

    FORMS = (
        ("quoted schema, quoted type (TypeORM baseline)",
         "CREATE TYPE \"farm\".\"harvest_grade_enum\" AS ENUM('a', 'b');", "harvest_grade_enum", ["a", "b"]),
        ("quoted type, no schema",
         "CREATE TYPE \"alert_history_module_enum\" AS ENUM ('farm', 'sensor');",
         "alert_history_module_enum", ["farm", "sensor"]),
        ("unquoted schema, unquoted type",
         "CREATE TYPE admin.audit_logs_severity_enum AS ENUM ('info', 'critical');",
         "audit_logs_severity_enum", ["critical", "info"]),
        ("quoted schema, unquoted type",
         "CREATE TYPE \"farm\".harvest_stage_enum AS ENUM ('early', 'late');", "harvest_stage_enum", ["early", "late"]),
        ("unquoted schema, quoted type",
         "CREATE TYPE farm.\"harvest_kind_enum\" AS ENUM ('wild', 'farmed');", "harvest_kind_enum", ["farmed", "wild"]),
        ("list on the next lines (billing form)",
         "CREATE TYPE billing.telemetry_capacity_state AS ENUM\n    (\n        'ok',\n        'capped'\n    );",
         "telemetry_capacity_state", ["capped", "ok"]),
        ("bare type (the one form it read before)",
         "CREATE TYPE goal_status AS ENUM ('open', 'done');", "goal_status", ["done", "open"]),
    )

    def test_each_form_yields_the_bare_type_name_and_its_values(self) -> None:
        for label, statement, name, values in self.FORMS:
            with self.subTest(label), tempfile.TemporaryDirectory() as td:
                tree = _Tree(Path(td))
                path = tree.write(ANCHOR_PATH, f"// header\n{statement}\n")
                enums = aria_poc.detect_sql_enums(tree.root, tree.fates)
                self.assertEqual([(e["name"], e["values"], e["ref"]) for e in enums],
                                 [(name, values, f"{path}:2")])

    def test_type_definitions_that_are_not_enums_stay_out(self) -> None:
        """Near-miss: quoted/qualified CREATE/DROP TYPE statements of other kinds
        sit beside the baseline enum and must not become value sets."""
        with tempfile.TemporaryDirectory() as td:
            tree = _Tree(Path(td))
            tree.write(ANCHOR_PATH, ANCHOR_SQL)
            tree.write(
                "apps/farm-service/src/database/migrations/1800100000000-Types.ts",
                'CREATE TYPE "farm"."geo_point" AS (lat double precision, lon double precision);\n'
                'CREATE TYPE "farm"."dose_range" AS RANGE (subtype = numeric);\n'
                'DROP TYPE IF EXISTS "farm"."retired_enum";\n',
            )
            self.assertEqual(tree.corpus(), [(ANCHOR_NAME, ANCHOR_PATH)])


class SqlEnumFilesComeFromTheRegistry(unittest.TestCase):
    """Which files are migrations is the registry's answer, not a path substring."""

    def test_every_registered_glob_is_read_wherever_its_directory_sits(self) -> None:
        registry = {
            **_FARM_ONLY,
            "auth-service": [_glob("apps/auth-service/src/migrations")],
            "messaging-service": [
                "// the first dir is the legacy one",
                _glob("apps/messaging-service/src/migrations") + ",",
                _glob("apps/messaging-service/src/database/migrations") + ",",
            ],
            "zeta-service": [_glob("apps/zeta-service/src/ddl/versions")],
        }
        with tempfile.TemporaryDirectory() as td:
            tree = _Tree(Path(td), registry)
            files = {
                ANCHOR_PATH: ANCHOR_SQL,
                "apps/auth-service/src/migrations/1800000000000-Baseline.ts":
                    "CREATE TYPE \"auth\".\"audit_logs_severity_enum\" AS ENUM('info', 'critical');\n",
                "apps/messaging-service/src/migrations/1800000000000-Baseline.ts":
                    "CREATE TYPE \"messaging\".\"first_dir_enum\" AS ENUM('a');\n",
                "apps/messaging-service/src/database/migrations/1800000000000-Second.ts":
                    "CREATE TYPE \"messaging\".\"second_dir_enum\" AS ENUM('b');\n",
                "apps/zeta-service/src/ddl/versions/1800000000000-Init.ts":
                    "CREATE TYPE \"zeta\".\"zeta_state_enum\" AS ENUM('on', 'off');\n",
            }
            for rel, text in files.items():
                tree.write(rel, text)
            self.assertEqual(tree.corpus(), sorted([
                (ANCHOR_NAME, ANCHOR_PATH),
                ("audit_logs_severity_enum", "apps/auth-service/src/migrations/1800000000000-Baseline.ts"),
                ("first_dir_enum", "apps/messaging-service/src/migrations/1800000000000-Baseline.ts"),
                ("second_dir_enum", "apps/messaging-service/src/database/migrations/1800000000000-Second.ts"),
                ("zeta_state_enum", "apps/zeta-service/src/ddl/versions/1800000000000-Init.ts"),
            ]))

    def test_directories_the_registry_does_not_name_are_not_read(self) -> None:
        """Near-miss: the old substring rule read all of these. A service absent
        from the registry, a registered path nested under another root (fixture
        workspaces exist under tools/), and an entity file of a registered service."""
        with tempfile.TemporaryDirectory() as td:
            tree = _Tree(Path(td))
            tree.write(ANCHOR_PATH, ANCHOR_SQL)
            decoy = "CREATE TYPE \"x\".\"decoy_enum\" AS ENUM('d');\n"
            tree.write("apps/ghost-service/src/database/migrations/1800000000000-Baseline.ts", decoy)
            tree.write(
                "tools/fixtures/ws/apps/farm-service/src/database/migrations/1800000000000-Baseline.ts", decoy)
            tree.write("apps/farm-service/src/farm/legacy.entity.ts", decoy)
            self.assertEqual(tree.corpus(), [(ANCHOR_NAME, ANCHOR_PATH)])

    def test_archived_migrations_stay_out_in_every_registered_directory(self) -> None:
        """Near-miss: ``src/migrations/.archive/`` (auth, admin-api, messaging,
        event-store) is not under ``/database/migrations/``, so the archive
        predicate alone would not cover it once those dirs are read."""
        registry = {**_FARM_ONLY, "auth-service": [_glob("apps/auth-service/src/migrations")]}
        with tempfile.TemporaryDirectory() as td:
            tree = _Tree(Path(td), registry)
            tree.write(ANCHOR_PATH, ANCHOR_SQL)
            tree.write(
                "apps/farm-service/src/database/migrations/.archive/2026-05-18T09-43-29-900Z/"
                "1736000000000-CreateFarm.ts", "CREATE TYPE \"farm\".\"old_farm_enum\" AS ENUM('o');\n")
            tree.write(
                "apps/auth-service/src/migrations/.archive/2026-05-18T09-35-46-244Z/"
                "1700000000000-CreateInitialSchema.ts", "CREATE TYPE auth.\"old_auth_enum\" AS ENUM('o');\n")
            tree.write(
                "apps/auth-service/src/migrations/1800000000000-Baseline.ts",
                "CREATE TYPE \"auth\".\"live_auth_enum\" AS ENUM('l');\n")
            self.assertEqual(tree.corpus(), sorted([
                (ANCHOR_NAME, ANCHOR_PATH),
                ("live_auth_enum", "apps/auth-service/src/migrations/1800000000000-Baseline.ts"),
            ]))

    def test_specs_and_support_modules_beside_migrations_are_not_migrations(self) -> None:
        """Near-miss: the registry loads timestamp-prefixed files directly in the
        directory. farm-service keeps ``__tests__/*.postgres.spec.ts`` with test DDL
        (``CREATE TYPE farm.water_quality_param_..._enum``); a helper module may sit
        beside the migrations without being one (schema-registry.ts, 'Why migrationsGlob')."""
        with tempfile.TemporaryDirectory() as td:
            tree = _Tree(Path(td))
            tree.write(ANCHOR_PATH, ANCHOR_SQL)
            tree.write(
                "apps/farm-service/src/database/migrations/__tests__/extend-param.migration.postgres.spec.ts",
                "CREATE TYPE farm.water_quality_param_equipment_monitoringfrequency_enum AS ENUM ('daily');\n")
            tree.write(
                "apps/farm-service/src/database/migrations/support/enum-helpers.ts",
                "CREATE TYPE \"farm\".\"helper_enum\" AS ENUM('h');\n")
            tree.write(
                "apps/farm-service/src/database/migrations/manifest.ts",
                "CREATE TYPE \"farm\".\"manifest_enum\" AS ENUM('m');\n")
            self.assertEqual(tree.corpus(), [(ANCHOR_NAME, ANCHOR_PATH)])

    def test_a_commented_out_glob_is_not_a_registered_directory(self) -> None:
        """Near-miss: a glob left in a comment inside the array is not an entry."""
        registry = {
            "farm-service": [
                _glob("apps/farm-service/src/database/migrations") + ",",
                "// " + _glob("apps/retired-service/src/migrations") + ",",
            ],
        }
        with tempfile.TemporaryDirectory() as td:
            tree = _Tree(Path(td), registry)
            tree.write(ANCHOR_PATH, ANCHOR_SQL)
            tree.write("apps/retired-service/src/migrations/1800000000000-Baseline.ts",
                       "CREATE TYPE \"retired\".\"retired_enum\" AS ENUM('r');\n")
            self.assertEqual(tree.corpus(), [(ANCHOR_NAME, ANCHOR_PATH)])


class SqlEnumCorpusOfTheRealRepo(unittest.TestCase):
    """Measured on the repository itself (DET-RCA: 29 of ~250 live enums seen)."""

    @classmethod
    def setUpClass(cls) -> None:
        root = _REPO_ROOT
        cls.registry_text = (root / REGISTRY_PATH).read_text(encoding="utf-8")
        fates = [aria_poc.assign_fate(p, root) for p in aria_poc.walk_repo(root)]
        cls.sql = aria_poc.detect_sql_enums(root, fates)
        ts_value_sets = [
            *aria_poc.detect_ts_enums(root, fates),
            *aria_poc.detect_ts_union_types(root, fates),
            *aria_poc.detect_ts_const_arrays(root, fates),
            *aria_poc.detect_zod_enums(root, fates),
            *aria_poc.detect_graphql_enums(root, fates),
            *aria_poc.detect_rust_enums(root, fates),
        ]
        cls.drifts_above, _ = aria_poc.find_drifts(ts_value_sets, cls.sql)

    def test_the_corpus_is_the_registry_s_live_enums_and_adds_no_drift(self) -> None:
        with self.subTest("the baseline enums behind quotes and under src/migrations are seen"):
            suppliers = [e for e in self.sql if e["name"] == ANCHOR_NAME]
            self.assertEqual([(e["values"], e["ref"].rsplit(":", 1)[0]) for e in suppliers],
                             [(ANCHOR_VALUES, ANCHOR_PATH)])
            for service in ("auth-service", "admin-api-service", "event-store-service"):
                prefix = f"apps/{service}/src/migrations/"
                self.assertTrue(any(e["ref"].startswith(prefix) for e in self.sql),
                                f"no SQL enum read from {prefix}")
            self.assertGreater(len(self.sql), 200, "only 29 of ~250 live CREATE TYPE ... AS ENUM were visible")
        with self.subTest("every enum lives in a directory the registry names"):
            registered = set(re.findall(r"'(apps/[^'\s]+?)/\[0-9\]\*\{\.ts,\.js\}'", self.registry_text))
            self.assertGreaterEqual(len(registered), 13)
            outside = sorted({e["ref"].rsplit(":", 1)[0].rsplit("/", 1)[0] for e in self.sql} - registered)
            self.assertEqual(outside, [], "SQL enums read from directories no migrationsGlob names")
        with self.subTest("no TS-vs-SQL drift above threshold on clean main"):
            self.assertEqual(self.drifts_above, [],
                             "quote/qualifier-aware reading plus registry directories must add 0 findings")


if __name__ == "__main__":
    unittest.main()
