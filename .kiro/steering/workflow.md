---
inclusion: always
---

# Spec Task Workflow

These rules apply to every spec task.

1. **Scope:** implement only the task that was started. Do not start, finish or partly implement any other task.
2. **Verification:** before ticking the task, run `npx tsc -b` and `npx vitest --run` yourself and paste their summary lines in the report.
3. **Spec documents are read-only:** do not edit any spec's `requirements.md` or `design.md`, or `hexcard_design_spec.md`. If one of them is wrong or incomplete, stop and report the gap instead of working around it.
4. **Git:** never commit or push.
5. **Report ending:** end the report with a "Decisions for review" section listing every choice the spec did not dictate.
