<!-- source: src/run/wave-loop.ts → zero-work retry composition -->
<!-- two variants based on what failed: POSTFAILED (postcondition failed) or NOFILES (no file edits) -->

<!-- POSTFAILED -->

{{taskPrompt}}

The postcondition `{{postcondition}}` failed after your last attempt:
{{output}}

Fix what makes the check fail and try again.

<!-- @@@ -->

<!-- NOFILES -->

{{taskPrompt}}

IMPORTANT: your last attempt made no file edits. If the fix truly needs no changes, say 'no-op:' at the start and explain why. Otherwise, make the actual edits.
