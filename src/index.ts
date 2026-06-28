/**
 * Long-running entry point for Railway.
 *
 * Unlike the previous Vercel setup (webhook function + cron function), Railway
 * runs a persistent process, so we use:
 *   - long polling (bot.start) to receive Telegram updates, and
 *   - a setInterval loop to check games for turn/solution timeouts.
 */

import 'dotenv/config';
import { createBot, registerCommands } from './bot';
import { checkAllGameTimeouts } from './timeout';

/** How often to check active games for turn/solution timeouts (ms) */
const TIMEOUT_CHECK_INTERVAL_MS = 15_000;

async function main(): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error('BOT_TOKEN environment variable is not set');
  }

  const bot = createBot(token);

  // Register slash commands with Telegram
  await registerCommands(bot);

  // We use long polling on Railway, so make sure no webhook is left over
  // from the Vercel deployment (otherwise getUpdates returns 409 Conflict).
  await bot.api.deleteWebhook();

  // Periodically check active games for turn/solution timeouts.
  const timeoutTimer = setInterval(() => {
    checkAllGameTimeouts().catch((err) => console.error('Timeout check failed:', err));
  }, TIMEOUT_CHECK_INTERVAL_MS);

  // Graceful shutdown on Railway redeploy/stop
  const shutdown = async () => {
    clearInterval(timeoutTimer);
    await bot.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Safety net: a stray background rejection should be logged, not crash the process.
  process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));

  console.log('🎡 Hangman bot starting (long polling)...');
  await bot.start({
    onStart: (info) => console.log(`Bot @${info.username} is running`),
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
