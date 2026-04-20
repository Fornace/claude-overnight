<!-- source: src/planner/steering.ts → steerWave() parse retry -->
<!-- one-shot reformat request when the steerer's first response failed JSON.parse -->

Your previous steering response could not be parsed as JSON. Here is what you returned:

---
{{snippet}}
---

Extract or rewrite the above as ONLY a valid JSON object with this schema: {"done":boolean,"reasoning":"...","statusUpdate":"...","tasks":[{"prompt":"..."}]}

Respond with ONLY the JSON, no markdown fences, no explanation.
