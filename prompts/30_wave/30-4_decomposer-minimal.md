<!-- source: src/run/run.ts → runSteering() decomposer fallback -->
<!-- last-resort planner query after the steerer fails MAX_STEER_ATTEMPTS times -->

{{#if objective}}Objective: {{objective}}

{{/if}}Status:
{{status}}

Return tasks: string[] — 3-6 specific follow-ups. JSON only. {"tasks":[{"prompt":"..."}]}
