import React, { useState } from 'react';
import {
  History,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  RotateCcw,
  Film,
  Image as ImageIcon,
  Layers,
  Search,
  Activity,
  XCircle
} from 'lucide-react';
import { Job, JobDestination, JobMedia, JobEvent } from '../types.ts';
import { api } from '../api.ts';

interface HistoryTabProps {
  jobs: Job[];
  onRefresh: () => void;
  loading: boolean;
}

export const HistoryTab: React.FC<HistoryTabProps> = ({ jobs, onRefresh, loading }) => {
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDetails, setJobDetails] = useState<{ job: Job; media: JobMedia[]; destinations: JobDestination[]; logs: any[]; events?: JobEvent[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  const fetchJobDetails = async (id: string) => {
    setSelectedJobId(id);
    setDetailLoading(true);
    setRetryMessage(null);
    try {
      const data = await api.getJobDetails(id);
      setJobDetails(data);
    } catch (e) {
      console.error('Error fetching job details:', e);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleRetryFailed = async (id: string) => {
    setRetrying(true);
    setRetryMessage(null);
    try {
      const res = await api.retryJob(id);
      setRetryMessage(res.message || 'Retry initiated.');
      await fetchJobDetails(id);
      onRefresh();
    } catch (e: any) {
      setRetryMessage(`Retry error: ${e.message}`);
    } finally {
      setRetrying(false);
    }
  };

  const filteredJobs = jobs.filter(j => {
    if (filter !== 'all' && j.status !== filter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (j.caption || '').toLowerCase().includes(q) || j.id.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-24 md:pb-12 text-zinc-100">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
        <div>
          <h1 className="text-base font-bold text-white tracking-tight">Job History & Destinations</h1>
          <p className="text-xs text-zinc-400">
            Independent per-destination tracking, stage events, visible error reasons, and idempotent retries.
          </p>
        </div>

        <button
          onClick={onRefresh}
          disabled={loading}
          className="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors"
          title="Refresh history"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-zinc-900 border border-zinc-800 rounded-xl p-3">
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
          {['all', 'published', 'partially_published', 'publishing', 'processing', 'scheduled', 'failed', 'cancelled'].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold uppercase tracking-wider shrink-0 transition-colors ${
                filter === s
                  ? 'bg-orange-600 text-white'
                  : 'bg-zinc-950 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
              }`}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>

        <div className="relative min-w-[200px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-zinc-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search caption or ID..."
            className="w-full pl-8 pr-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500"
          />
        </div>
      </div>

      {/* Jobs List */}
      {filteredJobs.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-xs text-zinc-500 space-y-2">
          <History className="w-8 h-8 mx-auto opacity-30" />
          <p>No jobs found matching the selected filters.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filteredJobs.map((j) => {
            const isPublished = j.status === 'published';
            const isPartial = j.status === 'partially_published';
            const isFailed = j.status === 'failed';
            const isProcessing = j.status === 'processing' || j.status === 'publishing';
            const isCancelled = j.status === 'cancelled';

            return (
              <div
                key={j.id}
                onClick={() => fetchJobDetails(j.id)}
                className="bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 rounded-xl p-4 cursor-pointer transition-all flex flex-col gap-2 text-xs"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-mono text-[10px] text-zinc-500">{j.id}</span>
                      <span className="text-zinc-600">•</span>
                      <span className="text-[11px] text-zinc-400">
                        {new Date(j.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      </span>
                      {j.story_enabled === 1 && (
                        <span className="bg-purple-950 text-purple-300 border border-purple-800 px-1.5 py-0.2 rounded text-[9px] font-bold">
                          Story
                        </span>
                      )}
                      <span className="text-zinc-600">•</span>
                      <span className="text-[10px] uppercase font-bold text-zinc-400 bg-zinc-800/80 px-1.5 py-0.2 rounded">
                        Mode: {j.publish_mode}
                      </span>
                    </div>

                    <p className="font-medium text-zinc-200 line-clamp-2 mb-1">
                      {j.caption || '(Media Only Post)'}
                    </p>

                    {j.hashtags && (
                      <p className="text-[11px] text-orange-400/80 truncate">{j.hashtags}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-start">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                        isPublished
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                          : isPartial
                          ? 'bg-amber-950 text-amber-300 border border-amber-800'
                          : isFailed
                          ? 'bg-red-950 text-red-300 border border-red-800'
                          : isProcessing
                          ? 'bg-blue-950 text-blue-300 border border-blue-800 animate-pulse'
                          : isCancelled
                          ? 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                          : 'bg-zinc-800 text-zinc-300'
                      }`}
                    >
                      {j.status.replace('_', ' ')}
                    </span>
                    <ChevronRight className="w-4 h-4 text-zinc-500" />
                  </div>
                </div>

                {/* Visible failure / error banner */}
                {j.error_message && (
                  <div className="mt-1 p-2 rounded-lg bg-red-950/60 border border-red-800/80 text-red-300 text-[11px] flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />
                      <span className="truncate">{j.error_message}</span>
                    </div>
                    {(isFailed || isPartial) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRetryFailed(j.id);
                        }}
                        disabled={retrying}
                        className="px-2 py-0.5 rounded bg-red-900/80 hover:bg-red-800 text-white font-semibold text-[10px] shrink-0 transition-colors"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detailed Modal / Drawer */}
      {selectedJobId && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-4">
          <div className="w-full max-w-2xl bg-zinc-900 border border-zinc-700 rounded-2xl p-5 text-zinc-100 max-h-[90vh] overflow-y-auto space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <span className="font-mono text-xs text-orange-400 font-bold block">{selectedJobId}</span>
                <span className="text-xs text-zinc-400">Detailed Job Lifecycle & Diagnostics</span>
              </div>
              <button
                onClick={() => setSelectedJobId(null)}
                className="text-zinc-400 hover:text-white text-base px-2"
              >
                ✕
              </button>
            </div>

            {retryMessage && (
              <div className="p-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-orange-400" />
                <span>{retryMessage}</span>
              </div>
            )}

            {detailLoading ? (
              <div className="py-12 text-center text-xs text-zinc-500 flex items-center justify-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-orange-500" />
                <span>Loading lifecycle & destination breakdown...</span>
              </div>
            ) : jobDetails ? (
              <div className="space-y-4 text-xs">
                {/* Status & Error Banner */}
                {jobDetails.job.error_message && (
                  <div className="p-3 bg-red-950/80 border border-red-800 rounded-xl text-red-300 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
                    <div className="flex-1">
                      <span className="font-semibold block text-red-200">Execution Error</span>
                      <p className="text-[11px] mt-0.5">{jobDetails.job.error_message}</p>
                    </div>
                  </div>
                )}

                {/* Caption & Hashtags */}
                <div className="p-3.5 bg-zinc-950 rounded-xl border border-zinc-800">
                  <span className="text-[10px] uppercase font-bold text-zinc-500 block mb-1">Caption</span>
                  <p className="text-zinc-200 whitespace-pre-wrap">{jobDetails.job.caption || '(No caption text)'}</p>
                  {jobDetails.job.hashtags && (
                    <p className="text-orange-400 mt-2 font-mono text-[11px]">{jobDetails.job.hashtags}</p>
                  )}
                </div>

                {/* Media Assets */}
                <div>
                  <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-2">
                    Media Assets ({jobDetails.media.length})
                  </span>
                  {jobDetails.media.length === 0 ? (
                    <p className="text-zinc-500 text-[11px]">No media attached (Text post).</p>
                  ) : (
                    <div className="space-y-1.5">
                      {jobDetails.media.map((m, i) => (
                        <div
                          key={i}
                          className="p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg flex items-center justify-between"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {m.file_type === 'video' ? (
                              <Film className="w-4 h-4 text-purple-400 shrink-0" />
                            ) : (
                              <ImageIcon className="w-4 h-4 text-blue-400 shrink-0" />
                            )}
                            <div className="min-w-0">
                              <span className="font-semibold block truncate text-zinc-200">{m.filename || 'media'}</span>
                              <span className="text-[10px] text-zinc-500">
                                {m.file_type} • status: {m.status} • {m.release_tag || 'direct link'}
                              </span>
                            </div>
                          </div>
                          {m.asset_download_url && (
                            <a
                              href={m.asset_download_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-orange-400 hover:text-orange-300 p-1"
                              title="Download Asset"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Per Destination Status */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase font-bold text-zinc-400 block">
                      Target Destinations ({jobDetails.destinations.length})
                    </span>
                    {jobDetails.destinations.some(d => d.status === 'failed' || d.status === 'pending') && (
                      <button
                        onClick={() => handleRetryFailed(selectedJobId)}
                        disabled={retrying}
                        className="flex items-center gap-1 text-[11px] text-orange-400 hover:text-orange-300 font-semibold px-2 py-0.5 rounded bg-orange-950/60 border border-orange-800 transition-colors"
                      >
                        <RotateCcw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
                        <span>Retry Unfulfilled Destinations</span>
                      </button>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    {jobDetails.destinations.map((d, i) => (
                      <div
                        key={i}
                        className="p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg flex items-center justify-between"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-zinc-200 capitalize">{d.platform}</span>
                            <span className="text-[10px] uppercase px-1.5 py-0.2 rounded font-semibold bg-zinc-800 text-zinc-400">
                              {d.post_type}
                            </span>
                            <span className="text-[10px] text-zinc-500">
                              attempts: {d.attempts}
                            </span>
                          </div>
                          {d.error_message && (
                            <p className="text-[11px] text-red-400 mt-1">{d.error_message}</p>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              d.status === 'published'
                                ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                : d.status === 'failed'
                                ? 'bg-red-950 text-red-300 border border-red-800'
                                : d.status === 'skipped'
                                ? 'bg-zinc-800 text-zinc-400'
                                : 'bg-blue-950 text-blue-300'
                            }`}
                          >
                            {d.status}
                          </span>
                          {d.external_post_url && (
                            <a
                              href={d.external_post_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-zinc-400 hover:text-white"
                              title="View published post"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Stage Event Timeline */}
                <div>
                  <span className="text-[10px] uppercase font-bold text-zinc-400 block mb-2">
                    Event Timeline
                  </span>
                  {(!jobDetails.events || jobDetails.events.length === 0) && (!jobDetails.logs || jobDetails.logs.length === 0) ? (
                    <p className="text-zinc-500 text-[11px]">No events recorded yet.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {(jobDetails.events && jobDetails.events.length > 0 ? jobDetails.events : jobDetails.logs).map((evt: any, i: number) => (
                        <div
                          key={i}
                          className="p-2 bg-zinc-950/70 border border-zinc-800/80 rounded text-[11px] flex items-start gap-2"
                        >
                          <Activity className="w-3.5 h-3.5 text-orange-400 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-zinc-300">
                                {evt.stage ? `[${evt.stage}]` : ''} {evt.message}
                              </span>
                              <span className="text-[10px] text-zinc-500 shrink-0">
                                {new Date(evt.created_at).toLocaleTimeString()}
                              </span>
                            </div>
                            {evt.details_json && (
                              <pre className="mt-1 text-[10px] text-zinc-400 font-mono bg-zinc-900 p-1 rounded overflow-x-auto">
                                {evt.details_json}
                              </pre>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
