from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError


def write_schema_snapshot(
    *,
    service: str,
    output: str | os.PathLike[str],
    database_url: str | None = None,
) -> dict[str, Any]:
    schema = service
    snapshot = collect_schema_snapshot(schema=schema, database_url=database_url)
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return {"schema_version": 1, "service": service, "output": path.as_posix(), "tables": len(snapshot["tables"])}


def collect_schema_snapshot(*, schema: str, database_url: str | None = None) -> dict[str, Any]:
    dsn = database_url or os.environ.get("DATABASE_URL")
    if not dsn:
        raise GovernanceError("db snapshot requires --database-url or DATABASE_URL")
    try:
        import psycopg  # type: ignore[import-not-found]
    except ImportError as exc:
        raise GovernanceError("db snapshot requires psycopg to be installed") from exc

    query = """
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = %s
      ORDER BY table_name, ordinal_position
    """
    tables: dict[str, dict[str, Any]] = {}
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cursor:
            cursor.execute(query, (schema,))
            for table_name, column_name, data_type, is_nullable in cursor.fetchall():
                table = tables.setdefault(
                    table_name,
                    {"schema": schema, "name": table_name, "columns": []},
                )
                table["columns"].append(
                    {
                        "name": column_name,
                        "dataType": data_type,
                        "isNullable": is_nullable,
                    },
                )
    return {"schema": schema, "tables": list(tables.values())}
