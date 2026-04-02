This is the ROCA Electron app — a productivity sidekick powered by Claude.

## Intelligence Directory

ROCA's behavior is defined by files in the `roca/` directory:

- `roca-prompt.md` — ROCA's identity and methodology
- `journal.md` — Task routing patterns
- `skills/` — Skill files with rules, checklists, and cases
- `proactive-prompt.md` — Proactive task management behavior

### Custom Intelligence

Set `ROCA_INTELLIGENCE_DIR` env var to point to your own intelligence directory. The app falls back to the bundled `roca/` directory if not set.

This lets you keep your custom prompts, skills, and patterns outside the app — version them separately, share them across machines, or keep them private.
