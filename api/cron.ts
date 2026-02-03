/**
 * Cron handler to check game timeouts
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAllGameTimeouts } from '../src/timeout';

const CRON_SECRET = process.env.CRON_SECRET || 'hangman-cron-2024';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret via query parameter
  if (req.query?.secret !== CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const result = await checkAllGameTimeouts();
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Cron error:', error);
    res.status(500).json({ error: 'Failed to check timeouts' });
  }
}
