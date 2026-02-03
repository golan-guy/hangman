/**
 * Vercel Webhook Handler for Telegram Bot
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { webhookCallback } from 'grammy';
import { createBot, registerCommands } from '../src/bot';

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

const bot = createBot(token);

let commandsRegistered = false;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!commandsRegistered) {
    await registerCommands(bot);
    commandsRegistered = true;
  }

  if (req.method === 'POST') {
    try {
      await webhookCallback(bot, 'http')(req, res);
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).send('Error');
    }
  } else {
    res.status(200).send('🎡 Hangman Bot is running!');
  }
}
