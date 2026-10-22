import React, { useState, useEffect } from 'react';
import {
  Clock,
  Calendar,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Settings,
  RefreshCw,
  Sparkles,
  ArrowRight
} from 'lucide-react';
import { Job, QueueConfig } from '../types.ts';
import { api } from '../api.ts';
import { TabType } from './Navbar.tsx';

interface QueueTabProps {
  onNavigate: (tab: TabType) => void;
  onRefresh: () => void;
}

export const QueueTab: React.FC<QueueTabProps> = ({ onNavigate, onRefresh }) => {
  const [queueData, setQueueData] = useState<{ config: QueueConfig; queued_jobs: Job[]; next_available_slot: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const fetchQueue = async () => {
    setLoading(true);
    try {
      const data = await api.getQueue();
      setQueueData(data);
    } catch (e) {
      console.error('Queue fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQueue();
  }, []);

  const handleCancel = async (id: string) => {
    if (!window.confirm('Cancel this queued post?')) return;
    setCancellingId(id);
    try {
      await api.cancelJob(id);
      await fetchQueue();
      onRefresh();
    } catch (e) {
      console.error('Cancel error:', e);
    } finally {
      setCancellingId(null);
    }
  };

  const config = queueData?.config;
  const queuedJobs = queueData?.queued_jobs || [];

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-24 md:pb-12 text-zinc-100">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
        <div>
          <h1 className="text-base font-bold text-white tracking-tight">Publication Queue</h1>
          <p className="text-xs text-zinc-400">
            Posts are dispatched automatically based on your scheduling rules ({config?.timezone || 'Africa/Lagos'}).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate('settings')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium border border-zinc-700 transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Configure Slots</span>
          </button>
          <button
            onClick={fetchQueue}
            disabled={loading}
            className="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Queue Info Card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs">
        <div>
          <span className="font-semibold text-zinc-200 block mb-1">Queue Frequency:</span>
          <div className="flex flex-wrap items-center gap-2 text-zinc-400">
            <span className="text-orange-400 font-semibold">{config?.posts_per_day || 3} posts/day</span>
            <span>•</span>
            <span>Daily slots: {config?.daily_times?.join(', ') || '09:00, 14:00, 19:00'}</span>
            <span>•</span>
            <span className="bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded text-[10px]">
              {config?.timezone || 'Africa/Lagos'}
            </span>
          </div>
        </div>

        <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-right">
          <span className="text-[10px] text-zinc-500 uppercase block font-medium">Next Available Slot</span>
          <span className="text-xs font-bold text-emerald-400">
            {queueData?.next_available_slot
              ? new Date(queueData.next_available_slot).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
              : 'Calculating...'}
          </span>
        </div>
      </div>

      {/* Timeline of Queued Posts */}
      <div className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
          Upcoming Scheduled Items ({queuedJobs.length})
        </h2>

        {queuedJobs.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-xs text-zinc-500 space-y-3">
            <Clock className="w-8 h-8 mx-auto opacity-30" />
            <p>Your dispatch queue is empty.</p>
            <button
              onClick={() => onNavigate('create')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white rounded-lg text-xs font-semibold"
            >
              <span>Compose Post for Queue</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {queuedJobs.map((q, idx) => (
              <div
                key={q.id}
                className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-amber-950/60 border border-amber-800/60 text-amber-400 flex items-center justify-center font-bold text-xs shrink-0">
                    #{idx + 1}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-zinc-200 truncate">{q.caption || '(Media Only)'}</span>
                      {q.story_enabled === 1 && (
                        <span className="px-1.5 py-0.2 rounded bg-purple-950 text-purple-300 border border-purple-800 text-[10px]">
                          +Story
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-zinc-400">
                      <span className="text-amber-400 font-medium flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {q.scheduled_at
                          ? new Date(q.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
                          : 'Next free slot'}
                      </span>
                      <span>•</span>
                      <span>Mode: {q.publish_mode}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-center">
                  <button
                    onClick={() => handleCancel(q.id)}
                    disabled={cancellingId === q.id}
                    className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-red-400 px-2 py-1 rounded bg-zinc-950 border border-zinc-800 hover:border-red-900 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Cancel</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
