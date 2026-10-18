// FBA Admin: sending the weekly summary to Discord. Checked every hour while the extension's Chrome or the web app is
// open; sent once per week, on or after the chosen day and hour (so if nothing was open, it goes the next time something is).
// "Sent this week" is a synced setting, and each device syncs before sending, so only one of your devices posts it.
import { loadAll, saveSettings } from './store.js';
import { buildWeekly, weekKey } from './weekly.js';
import { discordSend } from '../services.js';
import { syncNow, syncState } from '../sync/sync.js';

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function due(s, now = new Date()) {
  const today = localToday();
  const thisWeek = weekKey(today); // Monday
  const dow = ((now.getDay() + 6) % 7) + 1; // 1 = Monday … 7 = Sunday
  const day = Number(s.weeklyDay || 1);
  const ok = dow > day || (dow === day && now.getHours() >= Number(s.weeklyHour ?? 8));
  return { ok: ok && s.weeklyLastSent !== thisWeek, thisWeek, today };
}

let sending = false;
export async function maybeSendWeekly({ force = false } = {}) {
  if (sending) return { sent: false, why: 'busy' };
  sending = true;
  try {
    let data = await loadAll();
    if (!force && !data.settings.weeklyDiscord) return { sent: false, why: 'off' };
    if (!force && !due(data.settings).ok) return { sent: false, why: 'not due' };
    // another device may have sent it already: check with them first
    if (!force && (await syncState()).enabled) {
      try { await syncNow({ reason: 'weekly' }); } catch { /* send anyway */ }
      data = await loadAll();
      if (!due(data.settings).ok) return { sent: false, why: 'sent elsewhere' };
    }
    const { thisWeek, today } = due(data.settings);
    const { _week, ...payload } = buildWeekly(data, { today });
    await discordSend(payload);
    await saveSettings({ weeklyLastSent: thisWeek });
    return { sent: true };
  } finally { sending = false; }
}
