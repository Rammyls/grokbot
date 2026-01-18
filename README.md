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
- Polls via reactions with auto-close and results.
- Tenor GIF search with `/gif`.
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
- `TENOR_API_KEY` (for `/gif` command)

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
/ask question: whats good ghost:false   (visible to everyone)
/ask question: whats good ghost:true    (visible only to you - default)
/poll question:"Best lunch?" options:"Pizza|Tacos|Sushi" duration:2h
/gif query:"vibes"
```

The `ghost` parameter controls message visibility:
- `ghost:true` (default) - Only you can see the bot's response (ephemeral message)
- `ghost:false` - Everyone in the channel can see the bot's response


### Memory controls
- `/memory on` — enable memory
- `/memory off` — disable memory
- `/memory view` — view the stored summary
- `/lobotomize` — wipe stored history
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
- Use `/ask` to interact with the bot (the `ghost` parameter has no effect in DMs)
- Direct messages work without needing to mention the bot
- Memory is enabled by default (can be toggled with `/memory on/off`)
- All conversation history and preferences are preserved

DMs are allowed for memory writes when the user has memory enabled.

### Polls
- Create a poll with mention syntax: reply with `@BotName poll "Question" "A" "B" --duration 2h`
- Or use `/poll question:"..." options:"A|B|C" duration:1d`
- Users vote by reacting with 1️⃣ 2️⃣ 3️⃣ ...
- Bot auto-closes at the deadline and posts results.

### GIFs
- Search Tenor with `/gif query:"cats"` (requires `TENOR_API_KEY`)

### Videos
- Reply to a video with `@BotName` or use `/ask` while replying; the bot will acknowledge video context. Advanced transcription is not enabled by default.

## Notes
- The bot stores full user messages **only** from allowlisted channels.
- Responses in non-allowlisted channels are stateless (only the triggering message + reply context).
- A short in-memory window of recent turns plus lightweight user/channel/server summaries are used in allowlisted channels.
- The bot keeps a small cache of known display names per server to make references feel more natural.
- Hate speech and protected-class harassment are blocked before the LLM.

## Data storage
SQLite is used via `better-sqlite3` and stored in `data.db` in the project root.
