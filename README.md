# GrokBot Discord Assistant

A production-ready Discord bot built with **discord.js v14** and Grok (OpenAI-compatible) chat completions. It supports mentions, slash commands, DMs, per-user memory, and strong anti-abuse controls.

## Features
- Mention-based responses using `@BotName` (replies with visible references).
- `/ask` slash command for the same behavior.
- DM support (no mention required).
- Per-user memory with opt-in/out controls.
- Channel allowlist for memory writes in guilds.
- Per-user cooldown and duplicate spam guard.
- Message edit handling with re-runs (60s window, throttled).
- Image support (attachments, embeds, and image URLs) with vision model routing.
- Admin command to purge bot messages from channels with flexible timeframes.

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
- `GROK_BASE_URL` (recommended: `https://api.x.ai`)

Optional:
- `GROK_MODEL` (default: `grok-4`)
- `GROK_VISION_MODEL` (optional override used only when images are present)
- `BOT_NAME` (default: `GrokBuddy`)
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
- `/memory-reset-guild` — admin-only: wipe memory for this guild
- `/memory-reset-user <user>` — admin-only: wipe memory for a user
- `/memory-reset-channel <channel>` — admin-only: wipe memory for a specific channel

### Channel allowlist (guild admins)
Memory starts disabled for all **guild channels**. In allowlisted guild channels, the bot passively records all messages from users who have memory enabled, regardless of whether the bot is mentioned or responds. This provides channel and server context for the bot. Use:
- `/memory-allow <channel>`
- `/memory-deny <channel>`
- `/memory-list`

### Message management (guild admins)
- `/purge <timeframe> <channel>` — delete all bot messages in a channel within the specified timeframe (1h, 6h, 12h, 24h, 7d, 30d, or all time)

### DM Support
The bot works fully in DMs with the same memory and conversation features as in guilds:
- Use `/ask` to interact with the bot
- Direct messages work without needing to mention the bot
- Memory is enabled by default (can be toggled with `/memory on/off`)
- All conversation history and preferences are preserved

DMs are allowed for memory writes when the user has memory enabled.

## Notes
- The bot stores full user messages **only** from allowlisted channels.
- Responses in non-allowlisted channels are stateless (only the triggering message + reply context).
- A short in-memory window of recent turns plus lightweight user/channel/server summaries are used in allowlisted channels.
- The bot keeps a small cache of known display names per server to make references feel more natural.
- Hate speech and protected-class harassment are blocked before the LLM.

## Data storage
SQLite is used via `better-sqlite3` and stored in `data.db` in the project root.
