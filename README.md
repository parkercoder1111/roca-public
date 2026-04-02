# ROCA — Your Productivity Sidekick

A desktop app powered by Claude that gives you an embedded AI terminal per task, voice mode, a built-in browser, document handling, and a skill system that gets smarter the more you use it.

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Claude](https://img.shields.io/badge/Powered%20by-Claude-D97706)

## What ROCA Does

- **Task + Terminal** — Every task gets its own Claude Code terminal. Click a task, open the terminal, and Claude has your full context (title, notes, uploaded files).
- **Voice Mode** — Talk to ROCA hands-free. It listens, transcribes, sends to Claude, and speaks the response back.
- **Built-in Browser** — Claude autonomously controls a Chromium browser to research, fill forms, and navigate the web for you.
- **Document Handling** — Drag in Word, Excel, PowerPoint, PDF, or images. ROCA converts and previews them inline, and Claude can read and create documents.
- **Skill System** — Teach ROCA how to do recurring tasks. Every correction becomes a rule. Over time, ROCA gets precise for YOUR specific workflow.
- **Weekly View** — See your week at a glance. Objectives, results, challenges.
- **Folders** — Organize tasks with color-coded folders.
- **Smart Organizer** — ROCA reviews your open tasks and suggests what to close vs. keep.
- **File Browser** — Navigate your project files, preview inline, edit and save.
- **Mobile Access** — Access ROCA from your phone on the same network.

## Prerequisites

- **macOS** (Apple Silicon or Intel)
- **Node.js 18+** — install via [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org)
- **Claude Code CLI** — ROCA runs Claude under the hood

### Install Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
```

You'll need an [Anthropic API key](https://console.anthropic.com/) — Claude Code will prompt you to authenticate on first run.

## Installation

### Option 1: Build & Install as macOS App (Recommended)

```bash
# Clone the repo
git clone https://github.com/parkercoder1111/roca-public.git
cd roca-public

# Install dependencies
npm install

# Build and install to /Applications
npm run install-app
```

This builds ROCA and copies it to `/Applications/ROCA.app`. Since the app is unsigned, the first time you open it:
1. **Right-click** the app in Applications → **Open**
2. Click **Open** in the dialog that appears
3. After that, it opens normally

### Option 2: Run from Source

```bash
# Clone the repo
git clone https://github.com/parkercoder1111/roca-public.git
cd roca-public

# Install dependencies
npm install

# Build
npm run build

# Run
npm start
```

### Option 3: Development Mode

```bash
npm install
npm run dev
```

This runs the app with hot reload — changes to the renderer (React) auto-refresh, and TypeScript recompiles on save.

## First Launch

When you open ROCA for the first time, you'll see **9 onboarding tasks** that walk you through everything:

1. **Welcome to ROCA** — how the task → terminal flow works
2. **Connect your tools** — set up MCP servers and API keys
3. **Integrate task sources** — pull from to-do apps, meeting recorders
4. **Learn the terminal** — slash commands, voice mode, browser control
5. **Document handling** — Word, Excel, PowerPoint, PDF support
6. **The skill system** — how `roca-prompt.md` and `journal.md` work
7. **Create your first skill** — build a skill for something you do repeatedly
8. **Set up your intelligence directory** — customize ROCA for your workflow
9. **Explore all features** — weekly view, folders, delegation, mobile access

Click into any task and open the terminal to get started.

## How the Skill System Works

ROCA's intelligence comes from simple markdown files:

```
roca/
├── roca-prompt.md      ← ROCA's identity and 4-step methodology
├── journal.md          ← Task routing — maps triggers to skill files
├── proactive-prompt.md ← Proactive task management behavior
└── skills/
    └── _template.md    ← Template for creating new skills
```

### The Loop

1. You give ROCA a task
2. ROCA scans `journal.md` for a matching pattern
3. ROCA loads the skill file and follows its rules + checklist
4. You correct something → the correction becomes a new rule
5. Next time, ROCA gets it right

### Custom Intelligence Directory

Keep your customizations separate from the app:

```bash
# Create your own intelligence directory
mkdir ~/roca-intelligence
cp -r roca/* ~/roca-intelligence/

# Tell ROCA to use it (add to ~/.zshrc)
export ROCA_INTELLIGENCE_DIR="$HOME/roca-intelligence"
```

## Optional Setup

### Voice Mode

Requires an [ElevenLabs](https://elevenlabs.io) API key:

```bash
# Add to ~/.zshrc
export ELEVENLABS_API_KEY="your-key"
```

### Connect Tools via MCP

ROCA runs Claude Code, which supports [MCP servers](https://docs.anthropic.com/en/docs/claude-code/mcp) for connecting to external tools:

- **CRM** — Salesforce, HubSpot, Pipedrive, etc.
- **Calendar** — Google Calendar, Outlook
- **Email** — Gmail, Outlook
- **Notes** — Notion, Obsidian
- **Project management** — Linear, Jira, Asana, Todoist

Configure MCP servers in `~/.claude/settings.json`.

## Terminal Commands

Type these in any task terminal:

| Command | What it does |
|---------|-------------|
| `/voice` | Toggle voice mode |
| `/browse <instruction>` | Claude controls the built-in browser |
| `/sync` | Pull tasks from connected sources |
| `/new <title>` | Create a new task |
| `/done` | Complete current task |
| `/organize` | Smart task review |
| `/popout` | Pop panel into separate window |
| `/help` | Show all commands |

## Project Structure

```
src/
├── main/           ← Electron main process
│   ├── main.ts         ← App lifecycle, IPC handlers
│   ├── database.ts     ← SQLite (tasks, folders, sessions)
│   ├── ptyManager.ts   ← Terminal session management (tmux)
│   ├── delegate.ts     ← Autonomous task analysis engine
│   ├── sync.ts         ← External task source sync
│   ├── browserManager.ts ← Built-in browser control
│   └── remoteServer.ts ← Mobile access server
├── renderer/       ← React frontend
│   ├── components/     ← UI components
│   └── lib/            ← Utilities, terminal theme, voice
├── mobile/         ← Mobile web app
└── shared/         ← Types, constants shared across processes
```

## License

MIT
