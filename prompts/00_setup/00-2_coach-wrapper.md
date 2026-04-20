<!-- source: src/planner/coach/coach.ts → runSetupCoach() and amendment retry -->
<!-- WRAP wraps the coach skill body with the user message; AMEND retries with user feedback -->

<!-- WRAP -->

{{skill}}

---

{{userMessage}}

Respond with the JSON object defined in "Invocation contract" only.

<!-- @@@ -->

<!-- AMEND -->

{{previousPrompt}}

---

User amendment (apply and return a revised JSON object):
{{amendment}}
