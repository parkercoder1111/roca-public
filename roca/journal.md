# ROCA Journal

> **This file = task routing.** Classify the task, load the right skill, execute.
> Related files: `roca-prompt.md` (identity) · `skills/` (rules + real cases per task type)

---

## Process — Run This for Every Task

### Step 1: Classify the Task

Scan the **Patterns** table below and find the matching key. If the task matches multiple patterns, pick the most specific one.

If no pattern matches, go to Step 2b.

### Step 2a: Load the Skill (pattern exists)

Open `skills/[key].md` for the matched pattern. Every skill has two sections:

- **Rules** — hard constraints. They exist because the user corrected something before. Read all of them before writing a single word.
- **Cases** — real examples. Replicate what worked. Avoid what was corrected.

### Step 2b: No Pattern Exists (new task type)

Gather all available context using your tools:
- Search your CRM, project management tools, or databases for relevant records
- Check local files, documents, or meeting notes
- Search past context that might be relevant

Execute the task using that full context. After completing it, add a new pattern to this journal so the next occurrence is faster.

### Step 3: Gather Context

Even with a skill, always pull fresh context before executing:
- Look up people/companies in your tools — don't rely on memory
- Pull meeting notes or transcripts if the task references a call
- Check calendar for timing if relevant

### Step 4: Execute

Run the skill's checklist top to bottom. If the user provides exact copy, use it verbatim — don't paraphrase or "improve" it.

### Step 5: Verify

Before reporting done:
- Read back what you wrote (email draft, document update, record change)
- Confirm it matches the skill's rules
- Report what was done, not what you plan to do

---

## Patterns

> Add your patterns here as you use ROCA. Each section groups related task types.
> Format: `key` | what the user says that triggers it | path to the skill file.

### Email

| Key | Triggers | Skill |
|-----|----------|-------|

*Add email patterns here as recurring email task types emerge.*

### Research

| Key | Triggers | Skill |
|-----|----------|-------|

*Add research patterns here as recurring research task types emerge.*

### Calendar

| Key | Triggers | Skill |
|-----|----------|-------|

*Add calendar patterns here as recurring calendar task types emerge.*

### Meeting Prep

| Key | Triggers | Skill |
|-----|----------|-------|

*Add meeting prep patterns here as recurring prep task types emerge.*

### Utility

| Key | Triggers | Behavior |
|-----|----------|----------|
| `util:screenshot-review` | User sends an image/screenshot | Always relevant to current task. Examine carefully. Extract actionable details. |
| `util:document-lookup` | User references a doc/file ROCA hasn't seen | Search first (local files, web). Only ask the user if search fails. |
| `util:conversational` | Greetings, short messages with no task reference | Match the user's energy. Be a person. |
