from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .burn_in import burn_in_report_schema
from .contract_digest import render_judge_digest
from .state_manifest import iter_surfaces
from .workflow_contracts import WORKFLOW_CONTRACTS, generated_workflow_inventory


def render_burn_in_schema_json() -> str:
    return json.dumps(burn_in_report_schema(), indent=2, sort_keys=True) + "\n"


def runtime_inventory(workspace_root: str | Path) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "state_surfaces": [
            {
                "name": surface.name,
                "path_pattern": surface.path_pattern,
                "root_kind": surface.root_kind,
                "state_class": surface.state_class,
                "strict_read": surface.strict_read,
                "write_driving": surface.write_driving,
                "profile_surface": surface.profile_surface,
                "observe_class": surface.observe_class,
                "enterprise_required": surface.enterprise_required,
            }
            for surface in iter_surfaces()
        ],
        "workflow_contracts": [
            {
                "workflow_id": contract.workflow_id,
                "workflow_file": contract.workflow_file,
                "job_contracts": [
                    {
                        "job_id": job.job_id,
                        "first_governed_mutation_step": job.first_governed_mutation_step,
                        "retention_days": job.retention_days,
                        "token_source": job.token_source,
                    }
                    for job in contract.job_contracts
                ],
            }
            for contract in sorted(WORKFLOW_CONTRACTS.values(), key=lambda item: item.workflow_id)
        ],
        "workflow_inventory": json.loads(generated_workflow_inventory(workspace_root)),
    }


def render_runtime_inventory_json(workspace_root: str | Path) -> str:
    return json.dumps(runtime_inventory(workspace_root), indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render generated ARIA docs SSoT artifacts.")
    parser.add_argument(
        "artifact",
        choices=("burn-in-schema", "runtime-inventory", "workflow-inventory", "judge-digest"),
    )
    parser.add_argument("--workspace-root", default=".")
    args = parser.parse_args(argv)
    if args.artifact == "burn-in-schema":
        print(render_burn_in_schema_json(), end="")
    elif args.artifact == "runtime-inventory":
        print(render_runtime_inventory_json(args.workspace_root), end="")
    elif args.artifact == "judge-digest":
        # E17-a — judge contract digest (İ1: one generated-docs CLI family).
        print(render_judge_digest(args.workspace_root), end="")
    else:
        print(generated_workflow_inventory(args.workspace_root), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
