import React, { useState } from 'react';
import {
  Send,
  Plus,
  Trash2,
  Folder,
  Link as LinkIcon,
  Search,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Film,
  Image as ImageIcon,
  Clock,
  Sparkles,
  Layers,
  ArrowRight
} from 'lucide-react';
import { ConnectedAccount, PlatformCapability } from '../types.ts';
import { api } from '../api.ts';

interface CreatePostTabProps {
  accounts: ConnectedAccount[];
  capabilities: Record<string, PlatformCapability>;
  onPostCreated: () => void;
}

export const CreatePostTab: React.FC<CreatePostTabProps> = ({
  accounts,
  capabilities,
  onPostCreated
}) => {
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('#motionsalt #design #animation');
  const [links, setLinks] = useState<string[]>(['']);
  const [inspectedMedia, setInspectedMedia] = useState<Array<{ url: string; name: string; file_type?: string; accessible: boolean }>>([]);
  const [inspecting, setInspecting] = useState(false);
  const [storyEnabled, setStoryEnabled] = useState(false);
  const [publishMode, setPublishMode] = useState<'now' | 'queue' | 'schedule'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>(accounts.map(a => a.id));
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string; runUrl?: string | null } | null>(null);

  const validateSourceLinksClient = (rawLinks: string[]): { valid: boolean; cleanLinks: string[]; error?: string } => {
    const cleanLinks = rawLinks.map(l => l.trim()).filter(l => l.length > 0);
    if (cleanLinks.length === 0) {
      return {
        valid: false,
        cleanLinks: [],
        error: 'Media Sources required: Provide at least one direct image/video URL or public Google Drive file/folder link.'
      };
    }

    for (let i = 0; i < cleanLinks.length; i++) {
      const candidate = cleanLinks[i];
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        return {
          valid: false,
          cleanLinks,
          error: `Media source link #${i + 1} is not a valid URL (${candidate.slice(0, 60)}).`
        };
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          valid: false,
          cleanLinks,
          error: `Media source link #${i + 1} must start with http:// or https://.`
        };
      }

      const host = parsed.hostname.toLowerCase();
      if (host === 'drive.google.com' || host.endsWith('.drive.google.com') || host === 'docs.google.com') {
        const folderMatch = parsed.pathname.match(/\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]{10,})/);
        const fileMatch = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
        const queryId = parsed.searchParams.get('id');
        if (!folderMatch && !fileMatch && !(queryId && /^[a-zA-Z0-9_-]{10,}$/.test(queryId))) {
          return {
            valid: false,
            cleanLinks,
            error: `Media source link #${i + 1} is a Google Drive URL without a valid file or folder ID.`
          };
        }
      }
    }

    return { valid: true, cleanLinks };
  };

  // Add/remove media link inputs
  const handleAddLink = () => setLinks([...links, '']);
  const handleUpdateLink = (idx: number, val: string) => {
    const copy = [...links];
    copy[idx] = val;
    setLinks(copy);
  };
  const handleRemoveLink = (idx: number) => {
    setLinks(links.filter((_, i) => i !== idx));
  };

  // Inspect drive or direct links
  const handleInspectLinks = async () => {
    const check = validateSourceLinksClient(links);
    if (!check.valid) {
      setFeedback({ type: 'error', message: check.error || 'Enter at least one valid media link to inspect.' });
      return;
    }
    setInspecting(true);
    setFeedback(null);
    try {
      const allFiles: any[] = [];
      for (const l of check.cleanLinks) {
        const res = await api.inspectDriveOrLink(l);
        if (res.files) {
          allFiles.push(...res.files);
        }
      }
      setInspectedMedia(allFiles);
      if (allFiles.length > 0) {
        setFeedback({ type: 'success', message: `Discovered and verified ${allFiles.length} media file(s).` });
      } else {
        setFeedback({ type: 'error', message: 'No accessible files found in specified links. Ensure Google Drive links are shared as "Anyone with the link".' });
      }
    } catch (e: any) {
      setFeedback({ type: 'error', message: `Inspection error: ${e.message}` });
    } finally {
      setInspecting(false);
    }
  };

  // Account selection toggles
  const handleToggleAccount = (id: string) => {
    if (selectedAccounts.includes(id)) {
      setSelectedAccounts(selectedAccounts.filter(a => a !== id));
    } else {
      setSelectedAccounts([...selectedAccounts, id]);
    }
  };

  const handleSelectAll = () => setSelectedAccounts(accounts.map(a => a.id));
  const handleDeselectAll = () => setSelectedAccounts([]);

  // Submit job
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const linkCheck = validateSourceLinksClient(links);
    if (!linkCheck.valid) {
      setFeedback({ type: 'error', message: linkCheck.error || 'Please provide at least one valid media source link.' });
      return;
    }

    if (selectedAccounts.length === 0) {
      setFeedback({ type: 'error', message: 'Please select at least one target destination account.' });
      return;
    }

    let normalizedScheduledAt: string | undefined;
    if (publishMode === 'schedule') {
      if (!scheduledAt || !scheduledAt.trim()) {
        setFeedback({ type: 'error', message: 'Please choose a schedule date and time.' });
        return;
      }
      const parsedDate = new Date(scheduledAt);
      if (Number.isNaN(parsedDate.getTime())) {
        setFeedback({ type: 'error', message: 'Invalid schedule date/time format.' });
        return;
      }
      normalizedScheduledAt = parsedDate.toISOString();
    }

    const browserTimezone =
      (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Africa/Lagos';

    setSubmitting(true);
    setFeedback(null);

    try {
      const res = await api.createJob({
        caption: caption.trim(),
        hashtags: hashtags.trim(),
        links: linkCheck.cleanLinks,
        publish_mode: publishMode,
        scheduled_at: normalizedScheduledAt,
        timezone: browserTimezone,
        story_enabled: storyEnabled,
        selected_destinations: selectedAccounts
      });

      if (res.success) {
        const dispatchedNow = res.status === 'processing' || publishMode === 'now';
        const formattedSchedule = res.scheduled_at
          ? new Date(res.scheduled_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
          : 'next queue slot';
        setFeedback({
          type: 'success',
          message: dispatchedNow
            ? `Job ${res.job_id} dispatched to GitHub Actions (${linkCheck.cleanLinks.length} media source${linkCheck.cleanLinks.length !== 1 ? 's' : ''})!`
            : `Job ${res.job_id} scheduled for ${formattedSchedule} (${linkCheck.cleanLinks.length} media source${linkCheck.cleanLinks.length !== 1 ? 's' : ''} saved).`,
          runUrl: res.workflow_run_url || null
        });
        setCaption('');
        setLinks(['']);
        setInspectedMedia([]);
        onPostCreated();
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Job creation failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const selectedTargets = accounts.filter(a => selectedAccounts.includes(a.id));

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-24 md:pb-12 text-zinc-100">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
        <div>
          <h1 className="text-base font-bold text-white tracking-tight">Create & Schedule Post</h1>
          <p className="text-xs text-zinc-400">
            Accepts direct media URLs and public Google Drive folders. No local uploads.
          </p>
        </div>
        <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded font-medium">
          {selectedTargets.length} destination{selectedTargets.length !== 1 ? 's' : ''}
        </span>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg text-xs flex items-center justify-between gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300'
              : 'bg-red-950/80 border border-red-800 text-red-300'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
            )}
            <span>{feedback.message}</span>
          </div>
          {feedback.runUrl && (
            <a
              href={feedback.runUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 px-2.5 py-1 rounded bg-emerald-900/70 hover:bg-emerald-800 text-emerald-100 font-semibold inline-flex items-center gap-1"
            >
              <span>View Run Log</span>
              <ArrowRight className="w-3 h-3" />
            </a>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        {/* Caption & Hashtags */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-zinc-200">Post Caption</label>
              <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                <span className={caption.length > 280 ? 'text-amber-400' : 'text-zinc-500'}>
                  X limit: {caption.length}/280
                </span>
                <span>•</span>
                <span className="text-zinc-500">Threads: {caption.length}/500</span>
              </div>
            </div>
            <textarea
              rows={4}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="What are you announcing? (e.g. New MotionSalt 3D animation release...)"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-200 mb-1.5">
              Hashtags (auto-appended to compliant platforms)
            </label>
            <input
              type="text"
              value={hashtags}
              onChange={(e) => setHashtags(e.target.value)}
              placeholder="#motionsalt #motiongraphics #3d #blender"
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500"
            />
          </div>
        </div>

        {/* Media Links Section */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LinkIcon className="w-4 h-4 text-orange-400" />
              <label className="text-xs font-semibold text-zinc-200">
                Media Sources <span className="text-orange-400">*</span>
              </label>
            </div>
            <button
              type="button"
              onClick={handleInspectLinks}
              disabled={inspecting}
              className="flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 font-medium px-2 py-1 rounded bg-orange-950/40 border border-orange-900/50"
            >
              <Search className="w-3.5 h-3.5" />
              <span>{inspecting ? 'Inspecting...' : 'Inspect Links'}</span>
            </button>
          </div>
          <p className="text-[11px] text-zinc-400">
            Required: Paste at least one accessible image/video URL (MP4, MOV, JPG, PNG) or public Google Drive file/folder link.
          </p>

          <div className="space-y-2">
            {links.map((link, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={link}
                  onChange={(e) => handleUpdateLink(idx, e.target.value)}
                  placeholder="https://example.com/video.mp4 or https://drive.google.com/drive/folders/..."
                  className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500"
                />
                {links.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveLink(idx)}
                    className="p-2 text-zinc-400 hover:text-red-400 rounded bg-zinc-950 border border-zinc-800"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={handleAddLink}
            className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-750 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Another Source Link</span>
          </button>

          {/* Inspected Preview Badges */}
          {inspectedMedia.length > 0 && (
            <div className="pt-2 border-t border-zinc-800/80">
              <span className="text-[11px] font-semibold text-zinc-300 block mb-1.5">
                Discovered Files ({inspectedMedia.length}):
              </span>
              <div className="flex flex-wrap gap-1.5">
                {inspectedMedia.map((m, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-300"
                  >
                    {m.file_type === 'video' ? (
                      <Film className="w-3 h-3 text-purple-400" />
                    ) : (
                      <ImageIcon className="w-3 h-3 text-blue-400" />
                    )}
                    <span className="truncate max-w-[140px]">{m.name}</span>
                    {m.accessible && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Story Toggle & Mode Switch */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Story Toggle */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-zinc-200 block">Publish to Stories</span>
              <p className="text-[11px] text-zinc-400">
                Instagram, TikTok, Telegram, and Pinterest where compatible.
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={storyEnabled}
                onChange={(e) => setStoryEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
            </label>
          </div>

          {/* Mode Selector */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <span className="text-xs font-semibold text-zinc-200 block mb-2">Publishing Mode</span>
            <div className="grid grid-cols-3 gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800 text-xs">
              <button
                type="button"
                onClick={() => setPublishMode('now')}
                className={`py-1.5 rounded font-medium transition-colors ${
                  publishMode === 'now' ? 'bg-orange-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Now
              </button>
              <button
                type="button"
                onClick={() => setPublishMode('queue')}
                className={`py-1.5 rounded font-medium transition-colors ${
                  publishMode === 'queue' ? 'bg-orange-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Queue
              </button>
              <button
                type="button"
                onClick={() => setPublishMode('schedule')}
                className={`py-1.5 rounded font-medium transition-colors ${
                  publishMode === 'schedule' ? 'bg-orange-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Schedule
              </button>
            </div>

            {publishMode === 'schedule' && (
              <div className="mt-2.5">
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-zinc-950 border border-zinc-700 rounded text-xs text-white"
                />
              </div>
            )}
          </div>
        </div>

        {/* Destination Accounts Selector */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-zinc-200">
              Target Destinations ({selectedAccounts.length}/{accounts.length})
            </label>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={handleSelectAll}
                className="text-orange-400 hover:underline"
              >
                Select All
              </button>
              <span>•</span>
              <button
                type="button"
                onClick={handleDeselectAll}
                className="text-zinc-400 hover:underline"
              >
                Clear
              </button>
            </div>
          </div>

          {accounts.length === 0 ? (
            <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 text-center text-xs text-zinc-400">
              No accounts discovered yet. Go to the Accounts tab and add your Zernio API key.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {accounts.map((acc) => {
                const isSelected = selectedAccounts.includes(acc.id);
                return (
                  <div
                    key={acc.id}
                    onClick={() => handleToggleAccount(acc.id)}
                    className={`p-2.5 rounded-lg border text-xs cursor-pointer flex items-center justify-between transition-colors ${
                      isSelected
                        ? 'bg-zinc-800/90 border-orange-500/60 text-white'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center uppercase font-bold text-[10px] text-zinc-300 shrink-0">
                        {acc.platform.slice(0, 2)}
                      </div>
                      <div className="min-w-0">
                        <span className="font-semibold block truncate text-zinc-200">{acc.name}</span>
                        <span className="text-[10px] text-zinc-500 uppercase block">{acc.platform}</span>
                      </div>
                    </div>
                    <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                      isSelected ? 'bg-orange-600 border-orange-500 text-white' : 'border-zinc-700'
                    }`}>
                      {isSelected && <CheckCircle2 className="w-3 h-3" />}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Compatibility Matrix Preview */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-xs space-y-2">
          <div className="flex items-center gap-1.5 text-zinc-300 font-semibold">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>Smart Distribution Preview</span>
          </div>
          <p className="text-[11px] text-zinc-400">
            Salt Relay automatically maps media to platform capabilities and splits carousels without failing incompatible destinations.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
            {['tiktok', 'youtube', 'instagram', 'twitter', 'threads', 'telegram', 'pinterest'].map(p => {
              const cap = capabilities[p];
              const isSelected = selectedTargets.some(t => t.platform === p);
              return (
                <div
                  key={p}
                  className={`p-2 rounded border text-[11px] ${
                    isSelected ? 'bg-zinc-900 border-zinc-700 text-zinc-200' : 'bg-zinc-950 border-zinc-850 text-zinc-600'
                  }`}
                >
                  <span className="font-bold uppercase text-[10px] block">{p}</span>
                  <span className="text-[10px] text-zinc-400">
                    {cap?.supported_media?.join(', ') || 'video'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3 px-4 bg-orange-600 hover:bg-orange-500 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-orange-950 transition-colors disabled:opacity-50"
        >
          {submitting ? (
            <span>Processing Dispatch...</span>
          ) : (
            <>
              <span>{publishMode === 'now' ? 'Dispatch Now' : 'Schedule to Pipeline'}</span>
              <Send className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
};
