# ARIA Agent Instruction Style

Date: 2026-05-25
Status: Normative for ARIA agent prompts

ARIA agents should not receive bare commands such as "do X" without context.
Every task prompt should teach the work in a cause/effect frame:

- What must be done.
- Why it matters.
- What breaks if it is skipped.
- Which downstream surface is affected.
- What evidence proves the work is complete.

This is operational safety, not tone polish. Agents make better decisions when
they can trace the consequence chain from task to failure mode to affected
system. Concise explanations are preferred, but the reasoning must be explicit.
