import React, { useState, useEffect } from 'react';
import {
  Settings,
  Clock,
  ShieldCheck,
  Save,
  CheckCircle2,
  Database,
  Cloud,
  Layers,
  Folder,
  Radio,
  ExternalLink
} from 'lucide-react';
import { QueueConfig } from '../types.ts';
import { api } from '../api.ts';

export const SettingsTab: React.FC = () => {
  const [config, setConfig] = useState<QueueConfig>({
    posts_per_day: 3,
    daily_times: ['09:00', '14:00', '19:00'],
    timezone: 'Africa/Lagos',
    is_active: true
  });
  const [dailyTimesInput, setDailyTimesInput] = useState('09:00, 14:00, 19:00');
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    api.getQueue().then(res => {
      if (res.config) {
        setConfig(res.config);
        setDailyTimesInput((res.config.daily_times || []).join(', '));
      }
    }).catch(console.error);

    api.getSystemStatus().then(res => {
      setSystemStatus(res);
    }).catch(console.error);
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const times = dailyTimesInput.split(',').map(t => t.trim()).filter(Boolean);
      await api.updateQueueSettings({
        posts_per_day: config.posts_per_day,
        daily_times: times,
        timezone: config.timezone,
        is_active: config.is_active
      });
      setFeedback('Queue schedule settings updated successfully.');
    } catch (e: any) {
      setFeedback(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-24 md:pb-12 text-zinc-100">
      <div className="border-b border-zinc-800 pb-3">
        <h1 className="text-base font-bold text-white tracking-tight">System & Schedule Settings</h1>
        <p className="text-xs text-zinc-400">
          Configure queue intervals, timezone dispatching, and Cloudflare/GitHub release policies.
        </p>
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-950/80 border border-emerald-800 rounded-lg text-xs text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{feedback}</span>
        </div>
      )}

      {/* Queue Rules Form */}
      <form onSubmit={handleSave} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-zinc-800">
          <Clock className="w-4 h-4 text-orange-400" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
            Queue Frequency & Slots
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
              Posts Per Day
            </label>
            <input
              type="number"
              min={1}
              max={24}
              value={config.posts_per_day}
              onChange={(e) => setConfig({ ...config, posts_per_day: parseInt(e.target.value, 10) || 1 })}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-white"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
              Timezone
            </label>
            <select
              value={config.timezone}
              onChange={(e) => setConfig({ ...config, timezone: e.target.value })}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-white"
            >
              <option value="Africa/Lagos">Africa/Lagos (WAT, UTC+1 - Default)</option>
              <option value="UTC">UTC (Coordinated Universal Time)</option>
              <option value="America/New_York">America/New_York (EST)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
              <option value="Europe/London">Europe/London (GMT/BST)</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
            Daily Scheduled Slots (comma separated 24h format)
          </label>
          <input
            type="text"
            value={dailyTimesInput}
            onChange={(e) => setDailyTimesInput(e.target.value)}
            placeholder="09:00, 14:00, 19:00"
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-white font-mono"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            The queue engine will assign posts to the next empty slot in this schedule.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg text-xs font-semibold shadow-md transition-colors disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          <span>{saving ? 'Saving...' : 'Save Queue Settings'}</span>
        </button>
      </form>

      {/* Infrastructure Diagnostics */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-zinc-800">
          <Database className="w-4 h-4 text-emerald-400" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
            Infrastructure & Storage Status
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg">
            <span className="text-[10px] text-zinc-500 uppercase block font-medium">Cloudflare D1 Database</span>
            <span className="font-semibold text-emerald-400 flex items-center gap-1.5 mt-0.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span>salt-relay-db (29f8c89b-41cf-4b7e-906c-a475eb06febc)</span>
            </span>
          </div>

          <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg">
            <span className="text-[10px] text-zinc-500 uppercase block font-medium">Cloudflare Worker API</span>
            <span className="font-semibold text-zinc-200 block truncate mt-0.5">
              {systemStatus?.worker_url || 'https://salt-relay-api.motionssalt.workers.dev'}
            </span>
          </div>

          <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg">
            <span className="text-[10px] text-zinc-500 uppercase block font-medium">Cloudflare Pages UI</span>
            <a
              href="https://salt-relay.pages.dev"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-orange-400 hover:underline flex items-center gap-1 mt-0.5"
            >
              <span>salt-relay.pages.dev</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg">
            <span className="text-[10px] text-zinc-500 uppercase block font-medium">GitHub Releases Rotation</span>
            <span className="font-semibold text-purple-400 block mt-0.5">
              Active: {systemStatus?.active_release || 'media-001'} (Limit: 50 assets/tag)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
