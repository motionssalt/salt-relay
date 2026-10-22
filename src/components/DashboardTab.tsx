import React from 'react';
import {
  Users,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Key,
  Layers,
  ArrowUpRight,
  PlusCircle,
  RefreshCw,
  Send,
  ExternalLink
} from 'lucide-react';
import { Job, ConnectedAccount, ZernioKey } from '../types.ts';
import { TabType } from './Navbar.tsx';

interface DashboardTabProps {
  jobs: Job[];
  accounts: ConnectedAccount[];
  keys: ZernioKey[];
  onNavigate: (tab: TabType) => void;
  onRefresh: () => void;
  loading: boolean;
}

export const DashboardTab: React.FC<DashboardTabProps> = ({
  jobs,
  accounts,
  keys,
  onNavigate,
  onRefresh,
  loading
}) => {
  const publishedJobs = jobs.filter(j => j.status === 'published' || j.status === 'partially_published');
  const queuedJobs = jobs.filter(j => j.status === 'scheduled' || j.status === 'pending');
  const failedJobs = jobs.filter(j => j.status === 'failed');

  const stats = [
    {
      label: 'Connected Accounts',
      value: accounts.length,
      sub: `${new Set(accounts.map(a => a.platform)).size} platforms active`,
      icon: Users,
      color: 'text-blue-400',
      action: () => onNavigate('accounts')
    },
    {
      label: 'Queued Posts',
      value: queuedJobs.length,
      sub: 'Next slot automatic',
      icon: Clock,
      color: 'text-amber-400',
      action: () => onNavigate('queue')
    },
    {
      label: 'Published Jobs',
      value: publishedJobs.length,
      sub: `${failedJobs.length} failed / partial`,
      icon: CheckCircle2,
      color: 'text-emerald-400',
      action: () => onNavigate('history')
    },
    {
      label: 'Active Zernio Keys',
      value: keys.filter(k => k.is_active).length,
      sub: 'Encrypted at rest (AES-GCM)',
      icon: Key,
      color: 'text-purple-400',
      action: () => onNavigate('accounts')
    }
  ];

  return (
    <div className="space-y-6 pb-20 md:pb-8">
      {/* Top Banner & Quick Actions */}
      <div className="bg-gradient-to-r from-zinc-900 to-zinc-900/80 border border-zinc-800 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-lg font-bold text-white tracking-tight">Social Dispatch Center</h1>
            <span className="text-[10px] bg-orange-950/80 text-orange-400 border border-orange-800/60 px-2 py-0.5 rounded-full font-semibold">
              Live Pipeline
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Publish and schedule across TikTok, YouTube, Threads, Instagram, X, Telegram, and Pinterest.
          </p>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            onClick={() => onNavigate('create')}
            className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg text-xs font-semibold shadow-md shadow-orange-950 transition-colors"
          >
            <PlusCircle className="w-4 h-4" />
            <span>Create Post</span>
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs transition-colors"
            title="Refresh status"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((stat, idx) => {
          const Icon = stat.icon;
          return (
            <div
              key={idx}
              onClick={stat.action}
              className="bg-zinc-900/90 border border-zinc-800/90 hover:border-zinc-700 rounded-xl p-4 cursor-pointer transition-all hover:bg-zinc-850"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-zinc-400 font-medium">{stat.label}</span>
                <Icon className={`w-4 h-4 ${stat.color}`} />
              </div>
              <div className="text-2xl font-black text-white">{stat.value}</div>
              <div className="text-[11px] text-zinc-500 mt-1 flex items-center justify-between">
                <span>{stat.sub}</span>
                <ArrowUpRight className="w-3 h-3 text-zinc-600" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Two Column Layout: Upcoming Queue & Recent History */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Next in Queue */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-zinc-800/80">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-400" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                Scheduled Queue
              </h2>
            </div>
            <button
              onClick={() => onNavigate('queue')}
              className="text-[11px] text-orange-400 hover:text-orange-300 font-medium"
            >
              Manage Queue →
            </button>
          </div>

          {queuedJobs.length === 0 ? (
            <div className="py-8 text-center text-zinc-500 text-xs">
              <Clock className="w-6 h-6 mx-auto mb-2 opacity-30" />
              No posts in queue. Click "Create Post" to schedule to the queue.
            </div>
          ) : (
            <div className="space-y-2.5">
              {queuedJobs.slice(0, 4).map((q) => (
                <div
                  key={q.id}
                  className="p-3 bg-zinc-950/80 border border-zinc-800/80 rounded-lg flex items-start justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-200 truncate">{q.caption || '(Media Post)'}</p>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-400">
                      <span className="text-amber-400">
                        {q.scheduled_at ? new Date(q.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : 'Next slot'}
                      </span>
                      <span>•</span>
                      <span className="capitalize">{q.publish_mode}</span>
                      {q.story_enabled === 1 && (
                        <span className="bg-purple-950 text-purple-300 border border-purple-800 px-1 rounded text-[10px]">
                          +Story
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] uppercase font-semibold bg-zinc-800 text-zinc-300">
                    {q.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-zinc-800/80">
            <div className="flex items-center gap-2">
              <Send className="w-4 h-4 text-emerald-400" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                Recent Dispatches
              </h2>
            </div>
            <button
              onClick={() => onNavigate('history')}
              className="text-[11px] text-orange-400 hover:text-orange-300 font-medium"
            >
              View All History →
            </button>
          </div>

          {jobs.length === 0 ? (
            <div className="py-8 text-center text-zinc-500 text-xs">
              <Layers className="w-6 h-6 mx-auto mb-2 opacity-30" />
              No jobs dispatched yet.
            </div>
          ) : (
            <div className="space-y-2.5">
              {jobs.slice(0, 4).map((j) => {
                const isPublished = j.status === 'published';
                const isFailed = j.status === 'failed';
                const isPartial = j.status === 'partially_published';

                return (
                  <div
                    key={j.id}
                    className="p-3 bg-zinc-950/80 border border-zinc-800/80 rounded-lg flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-200 truncate">{j.caption || '(Media Post)'}</p>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-500">
                        <span>{new Date(j.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <span>•</span>
                        <span>{j.timezone}</span>
                      </div>
                    </div>

                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                        isPublished
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                          : isFailed
                          ? 'bg-red-950 text-red-300 border border-red-800'
                          : isPartial
                          ? 'bg-amber-950 text-amber-300 border border-amber-800'
                          : 'bg-zinc-800 text-zinc-300'
                      }`}
                    >
                      {j.status}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
