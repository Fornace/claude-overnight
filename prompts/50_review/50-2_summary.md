<!-- source: src/run/summary.ts → generateFinalNarrative() -->
<!-- generates the 3-5 sentence human narrative at the end of a run -->

The autonomous run just ended. Final phase: {{phase}}.

{{#if objective}}
Objective: {{objective}}
{{/if}}

{{#if goal}}
Goal:
{{goal}}
{{/if}}

{{#if status}}
Status:
{{status}}
{{/if}}

{{#if waveCount}}
Waves completed: {{waveCount}}
{{/if}}

{{#if reflections}}
Reflections:
{{reflections}}
{{/if}}

{{#if verifications}}
Verifications:
{{verifications}}
{{/if}}

Write 3–5 plain sentences for the user: what was accomplished, what's still open, and any follow-ups they should do manually. No bullet points, no preamble, no markdown headers.
