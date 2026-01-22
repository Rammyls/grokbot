import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { setupEvents } from './events/index.js';
import { setupProcessGuards } from './utils/helpers.js';

const {
  DISCORD_TOKEN,
  GROK_BASE_URL,
  GROK_API_KEY,
  BOT_NAME = 'GrokBuddy',
  SUPER_ADMIN_USER_ID,
  GIPHY_API_KEY,
} = process.env;

if (!DISCORD_TOKEN || !GROK_BASE_URL || !GROK_API_KEY) {
  console.error('Missing required env vars: DISCORD_TOKEN, GROK_BASE_URL, GROK_API_KEY');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// In-memory state
const inMemoryTurns = new Map();
const pollTimers = new Map();

// Configuration
const config = {
  DISCORD_TOKEN,
  GROK_BASE_URL,
  GROK_API_KEY,
  BOT_NAME,
  SUPER_ADMIN_USER_ID,
  GIPHY_API_KEY,
};

async function main() {
  try {
    // Setup event listeners
    setupEvents({ client, config, inMemoryTurns, pollTimers });

    // Setup process guards
    setupProcessGuards(client);

    // Login
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
