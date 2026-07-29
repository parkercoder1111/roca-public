// First-launch onboarding. On a brand-new install (empty task list, flag unset)
// we seed a short guided sequence whose first tasks get the user's keys, Voice
// Mode, and Echo dictation working. Each task has its own Claude terminal, so
// the notes include a paste-ready prompt that lets Claude do the setup.
//
// Idempotent: gated by an `onboarding_seeded` flag in app_settings, and skipped
// entirely if the DB already has tasks (so upgrades never inject these).
import { getDb } from './connection'
import { createTask } from './tasks'

const SEED_FLAG = 'onboarding_seeded'

interface SeedTask {
  title: string
  priority: 'high' | 'medium' | 'low'
  notes: string
}

// Notes are markdown. Double-quoted so backticks render as literal inline code.
const ONBOARDING_TASKS: SeedTask[] = [
  {
    title: "👋 Start here — add your API keys",
    priority: "high",
    notes:
      "Welcome to ROCA! A few quick tasks to get you running. Start here.\n\n" +
      "ROCA runs on **Claude Code**. If you haven't already, open this task's terminal and run `claude` once to sign in.\n\n" +
      "**Add your API keys** — open Settings (the ⚙️ gear / settings bubble):\n" +
      "- **OpenAI** — powers Voice Mode and Echo dictation. Grab a key at platform.openai.com.\n" +
      "- **Anthropic** — Claude Code prompts you on first run.\n" +
      "- *(optional)* **ElevenLabs** — an alternative Voice Mode voice.\n\n" +
      "💬 **Or let Claude do it** — open the terminal on this task and paste:\n" +
      "> Check which API keys ROCA has configured and tell me exactly what's missing and where to add it.\n\n" +
      "Check this task off once your keys are in.",
  },
  {
    title: "🎙️ Set up Voice Mode",
    priority: "high",
    notes:
      "Talk to ROCA hands-free — it listens, transcribes, sends to Claude, and speaks the answer back.\n\n" +
      "**What it needs:**\n" +
      "- Your **OpenAI key** (from the first task) — the default text-to-speech + transcription.\n" +
      "- *(optional)* **local Whisper** for on-device transcription: `brew install whisper-cpp` plus a model file.\n\n" +
      "**Try it:** click the mic / voice toggle (or type `/voice` in a terminal) and say hello.\n\n" +
      "💬 **Let Claude set it up** — open this task's terminal and paste:\n" +
      "> Help me set up and test Voice Mode. Check whether whisper.cpp is installed, offer to install it and download a model, confirm my OpenAI key works, then tell me how to start talking.",
  },
  {
    title: "⌨️ Set up Echo (dictation)",
    priority: "high",
    notes:
      "Echo is system-wide dictation that **learns from your edits** — every correction sharpens its personal dictionary and writing style, so it gets more accurate the more you use it.\n\n" +
      "**What it needs:**\n" +
      "- **local Whisper** (`brew install whisper-cpp` + a model) for transcription.\n" +
      "- Your **OpenAI key** to clean up the text.\n\n" +
      "💬 **Let Claude set it up** — open this task's terminal and paste:\n" +
      "> Help me set up Echo dictation — verify whisper.cpp and my OpenAI key are ready, then tell me the hotkey to start dictating anywhere.",
  },
  {
    title: "🧠 Make ROCA yours — the skill system",
    priority: "medium",
    notes:
      "ROCA gets smarter the more you use it. Its brain is a few markdown files in `roca/`:\n" +
      "- `roca-prompt.md` — ROCA's identity + method\n" +
      "- `journal.md` — routes each task to the right skill\n" +
      "- `skills/` — your reusable playbooks (start from `skills/_template.md`)\n\n" +
      "Keep your customizations separate from the app by pointing ROCA at your own intelligence folder:\n" +
      "`export ROCA_INTELLIGENCE_DIR=\"$HOME/roca-intelligence\"`\n\n" +
      "Every time you correct ROCA, capture it as a rule — that's how it gets precise for *your* workflow.",
  },
  {
    title: "🚀 Explore ROCA",
    priority: "medium",
    notes:
      "The rest, at a glance:\n" +
      "- **Weekly view** — your week's objectives in one place\n" +
      "- **Folders** — color-coded organization\n" +
      "- **Built-in browser** — Claude drives a real browser for you\n" +
      "- **Meeting Notes** — record + auto-summarize meetings\n" +
      "- **Documents** — drag in Word/Excel/PDF; Claude reads and creates them\n" +
      "- **Mobile** — reach ROCA from your phone on the same network\n\n" +
      "Create your first real task, open its terminal, and go.",
  },
]

/**
 * Seed onboarding tasks on a fresh install. Safe to call on every startup:
 * runs at most once (flag-gated) and only when the DB has no tasks yet.
 */
export function seedOnboardingIfNeeded(): void {
  const db = getDb()
  try {
    const already = db
      .prepare("SELECT 1 FROM app_settings WHERE key = ? LIMIT 1")
      .get(SEED_FLAG)
    if (already) return

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }
    if (n === 0) {
      for (const t of ONBOARDING_TASKS) {
        createTask({ title: t.title, notes: t.notes, priority: t.priority, source: "manual" })
      }
      console.log(`[seed] Seeded ${ONBOARDING_TASKS.length} onboarding tasks`)
    }

    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, '1')").run(SEED_FLAG)
  } catch (err) {
    console.error("[seed] onboarding seed failed:", err)
  }
}
