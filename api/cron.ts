/**
 * Cron handler to check game timeouts every 30 seconds
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAllGameTimeouts } from '../src/timeout';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret (optional but recommended)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
