/**
 * Cron handler to check game timeouts
 * Runs two checks per invocation (0s and 30s) to achieve 30-second
 * granularity with a 1-minute cron schedule.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAllGameTimeouts } from '../src/timeout';

const CRON_SECRET = process.env.CRON_SECRET || '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret via query parameter
  if (req.query?.secret !== CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // First check — immediate
    const result1 = await checkAllGameTimeouts();

    // Wait 30 seconds, then check again
    await sleep(30_000);
    const result2 = await checkAllGameTimeouts();

    res.status(200).json({
      ok: true,
      firstPass: result1,
      secondPass: result2,
    });
  } catch (error) {
    console.error('Cron error:', error);
    res.status(500).json({ error: 'Failed to check timeouts' });
  }
}
