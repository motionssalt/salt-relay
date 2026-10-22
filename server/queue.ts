import { queryD1 } from './db.ts';

export interface QueueConfig {
  posts_per_day: number;
  daily_times: string[];
  timezone: string;
  is_active: boolean;
}

export async function getQueueConfig(): Promise<QueueConfig> {
  const rows = await queryD1('SELECT * FROM queue_settings WHERE id = ?', ['singleton']);
  if (!rows || rows.length === 0) {
    return {
      posts_per_day: 3,
      daily_times: ['09:00', '14:00', '19:00'],
      timezone: 'Africa/Lagos',
      is_active: true
    };
  }

  const r = rows[0];
  let dailyTimes: string[] = ['09:00', '14:00', '19:00'];
  try {
    dailyTimes = JSON.parse(r.daily_times_json);
  } catch (e) {}

  return {
    posts_per_day: r.posts_per_day || 3,
    daily_times: dailyTimes,
    timezone: r.timezone || 'Africa/Lagos',
    is_active: r.is_active === 1
  };
}

export async function calculateNextQueueSlot(): Promise<string> {
  const config = await getQueueConfig();
  const times = config.daily_times.sort();

  // Find all future scheduled jobs
  const scheduledRows = await queryD1<{ scheduled_at: string }>(
    `SELECT scheduled_at FROM jobs WHERE status IN ('scheduled', 'pending', 'processing') AND scheduled_at IS NOT NULL ORDER BY scheduled_at ASC`
  );
  const occupiedSlots = new Set(scheduledRows.map(r => r.scheduled_at));

  // Current date in target timezone
  const now = new Date();
  
  // Search up to 30 days ahead for next empty slot
  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const candidateDate = new Date(now.getTime() + dayOffset * 86400000);
    const dateStr = candidateDate.toISOString().split('T')[0];

    for (const timeStr of times) {
      const [h, m] = timeStr.split(':').map(Number);
      const slotDate = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);

      // Must be at least 5 minutes in the future
      if (slotDate.getTime() > now.getTime() + 5 * 60 * 1000) {
        const slotIso = slotDate.toISOString();
        if (!occupiedSlots.has(slotIso)) {
          return slotIso;
        }
      }
    }
  }

  // Fallback: 1 hour from now
  return new Date(now.getTime() + 3600 * 1000).toISOString();
}
