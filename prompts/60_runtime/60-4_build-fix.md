<!-- source: src/run/health.ts → checkProjectHealth() heal tasks -->
<!-- FILE: per-file heal when ≥2 source files have errors; ALL: single heal when errors don't span multiple files -->

<!-- FILE -->

Fix the broken build errors in `{{file}}`. `{{cmd}}` fails:
```
{{errors}}
```
Fix every error in this file. Run `{{cmd}}` when done to verify.

<!-- @@@ -->

<!-- ALL -->

Fix the broken build. `{{cmd}}` fails after merging parallel work:
```
{{errors}}
```
Fix every error. Run `{{cmd}}` when done to verify.
