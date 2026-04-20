<!-- source: src/swarm/branch-evaluator.ts → buildErroredBranchEvaluator() -->
<!-- runs when an agent errors mid-task; decides whether the partial diff is worth merging -->

You are evaluating whether partial work from an agent that errored mid-task should be kept or discarded.

Task: "{{task}}"

Diff of changes:
```
{{diff}}
```

Is this partial work coherent enough to land? Consider:
- Does it implement a meaningful portion of the task?
- Are the changes self-consistent (no half-written functions, broken imports)?
- Would merging this improve or degrade the codebase?

Respond with JSON: {"keep": true/false, "reason": "brief explanation"}
