/**
 * Vercel Webhook Handler for Telegram Bot
 */

import { webhookCallback } from 'grammy';
import { createBot } from '../src/bot';

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

const bot = createBot(token);

export default webhookCallback(bot, 'http');
