<!-- source: src/run/review.ts → reviewPrompt() -->
<!-- two variants: wave-level (after each wave) and run-level (final gate) -->

<!-- ── WAVE review ─────────────────────────────────────────────────────────── -->

Review and simplify all changes from the most recent wave.

Invoke the `simplify` skill to review changed code for reuse, quality, and efficiency, then fix any issues found.

<!-- @@@ -->

<!-- ── RUN review (final quality gate) ────────────────────────────────────── -->

You are the final quality gate before this autonomous run completes.

The objective was: {{objective}}

Invoke the `simplify` skill to review changed code for reuse, quality, and efficiency, then fix any issues found.
