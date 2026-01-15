# Grok

A production-ready Discord bot built with **discord.js v14** and Grok (OpenAI-compatible) chat completions. It supports mentions, slash commands, DMs, per-user memory, and strong anti-abuse controls.

## Features
- Mention-based responses using `@BotName` (replies with visible references).
- `/ask` slash command for the same behavior.
- DM support (no mention required).
- Per-user memory with opt-in/out controls.
- Channel allowlist for memory writes in guilds.
- Per-user cooldown and duplicate spam guard.
- Message edit handling with re-runs (60s window, throttled).
- Image support (attachments, embeds, and image URLs) with vision model routing (requires `GROK_VISION_MODEL` to be configured).

## Setup

### 1) Install dependencies
```bash
npm install
```

### 2) Configure environment
Copy `.env.example` to `.env` and fill it out:
```bash
cp .env.example .env
```

Required vars:
- `DISCORD_TOKEN`
- `GROK_API_KEY`
- `GROK_BASE_URL`

Optional:
- `GROK_MODEL` (default: `grok-beta`)
- `GROK_VISION_MODEL` (required for image understanding)
- `BOT_NAME` (default: `Grok`)
- `SUPER_ADMIN_USER_ID` (bypasses channel permission checks)

### 3) Run
```bash
npm start
```

Slash commands are registered automatically on startup.

## Usage

### Mention-based
In a server channel:
```
@BotName whats good
```

Replying to another message with an image also works:
```
@BotName what is this
```

### Slash command
```
/ask question: whats good
```

### Memory controls
- `/memory on` — enable memory
- `/memory off` — disable memory
- `/memory forget` — wipe stored history
- `/memory view` — view the stored summary

### Channel allowlist (guild admins)
Memory starts disabled for all **guild channels**. Use:
- `/memory-allow <channel>`
- `/memory-deny <channel>`
- `/memory-list`

DMs are allowed for memory writes when the user has memory enabled.

## Notes
- The bot stores full user messages **only** from allowed channels.
- A short in-memory window of recent turns is used for context.
- A lightweight summary is kept per user and sent to Grok.
- A basic keyword filter runs before the LLM to block some obvious hate speech and protected-class harassment, but it is not a comprehensive content moderation system and may miss abusive content.

## Data storage
SQLite is used via `better-sqlite3` and stored in `data.db` in the project root.
