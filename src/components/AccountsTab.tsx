import React, { useState } from 'react';
import {
  Key,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  Radio,
  ExternalLink
} from 'lucide-react';
import { ConnectedAccount, ZernioKey } from '../types.ts';
import { api } from '../api.ts';

interface AccountsTabProps {
  accounts: ConnectedAccount[];
  keys: ZernioKey[];
  onRefresh: () => void;
  loading: boolean;
}

export const AccountsTab: React.FC<AccountsTabProps> = ({
  accounts,
  keys,
  onRefresh,
  loading
}) => {
  const [showAddKey, setShowAddKey] = useState(false);
  const [keyLabel, setKeyLabel] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [platformFilter, setPlatformFilter] = useState<string>('all');

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyLabel.trim() || !apiKeyInput.trim()) return;

    setActionLoading(true);
    setFeedback(null);
    try {
      await api.addKey(keyLabel.trim(), apiKeyInput.trim());
      setFeedback({ type: 'success', message: `API Key "${keyLabel}" encrypted with AES-GCM and stored in D1.` });
      setKeyLabel('');
      setApiKeyInput('');
      setShowAddKey(false);
      onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Failed to add key' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteKey = async (id: string, label: string) => {
    if (!window.confirm(`Delete key "${label}" and all its connected accounts?`)) return;
    setActionLoading(true);
    try {
      await api.deleteKey(id);
      setFeedback({ type: 'success', message: `Key "${label}" deleted.` });
      onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSyncAccounts = async () => {
    setActionLoading(true);
    setFeedback(null);
    try {
      const res = await api.syncAccounts();
      if (res.success) {
        setFeedback({
          type: 'success',
          message: `Synchronized ${res.total_accounts_synced} account(s) across all active Zernio keys.`
        });
        onRefresh();
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Account sync failed' });
    } finally {
      setActionLoading(false);
    }
  };

  const platforms = ['all', 'tiktok', 'youtube', 'threads', 'instagram', 'twitter', 'telegram', 'pinterest'];

  const filteredAccounts = platformFilter === 'all'
    ? accounts
    : accounts.filter(a => a.platform === platformFilter);

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-24 md:pb-12 text-zinc-100">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-zinc-800 pb-3">
        <div>
          <h1 className="text-base font-bold text-white tracking-tight">Accounts & Zernio API Keys</h1>
          <p className="text-xs text-zinc-400">
            Keys are AES-GCM encrypted in D1 and never exposed to the client.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddKey(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-semibold border border-zinc-700 transition-colors"
          >
            <Plus className="w-3.5 h-3.5 text-orange-400" />
            <span>Add Key</span>
          </button>
          <button
            onClick={handleSyncAccounts}
            disabled={actionLoading || loading || keys.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-orange-600 hover:bg-orange-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${actionLoading || loading ? 'animate-spin' : ''}`} />
            <span>Sync Accounts</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300'
              : 'bg-red-950/80 border border-red-800 text-red-300'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Add Key Modal */}
      {showAddKey && (
        <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700 shadow-xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white flex items-center gap-1.5">
              <Key className="w-4 h-4 text-orange-400" />
              <span>Add New Zernio API Key</span>
            </span>
            <button
              onClick={() => setShowAddKey(false)}
              className="text-xs text-zinc-400 hover:text-white"
            >
              ✕
            </button>
          </div>

          <form onSubmit={handleAddKey} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  Key Label / Owner
                </label>
                <input
                  type="text"
                  value={keyLabel}
                  onChange={(e) => setKeyLabel(e.target.value)}
                  placeholder="e.g. Victor Main Zernio Key"
                  className="w-full px-3 py-1.5 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  Zernio API Key
                </label>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="zrn_..."
                  className="w-full px-3 py-1.5 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500"
                  required
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowAddKey(false)}
                className="px-3 py-1.5 bg-zinc-800 text-zinc-300 hover:text-white rounded text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={actionLoading}
                className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 text-white rounded text-xs font-semibold transition-colors"
              >
                Save & Encrypt Key
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Configured Keys Section */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
              Configured Keys ({keys.length})
            </h2>
          </div>
          <span className="text-[11px] text-zinc-500">D1 AES-GCM Encrypted</span>
        </div>

        {keys.length === 0 ? (
          <div className="py-6 text-center text-xs text-zinc-500">
            No API keys configured. Click "+ Add Key" to configure your Zernio credentials.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {keys.map((k) => (
              <div
                key={k.id}
                className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg flex items-center justify-between text-xs"
              >
                <div>
                  <span className="font-semibold text-zinc-200 block truncate">{k.label}</span>
                  <span className="font-mono text-[10px] text-zinc-500 block">{k.masked_key}</span>
                  <span className="text-[10px] text-zinc-400 mt-1 block">
                    {k.connected_accounts_count || 0} account(s) bound
                  </span>
                </div>
                <button
                  onClick={() => handleDeleteKey(k.id, k.label)}
                  title="Delete key"
                  className="p-1.5 text-zinc-500 hover:text-red-400 rounded hover:bg-zinc-900 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Connected Accounts Section */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pb-2 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-400" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
              Discovered Social Accounts ({filteredAccounts.length})
            </h2>
          </div>

          {/* Platform Filter Chips */}
          <div className="flex items-center gap-1 overflow-x-auto max-w-full pb-1">
            {platforms.map((p) => (
              <button
                key={p}
                onClick={() => setPlatformFilter(p)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium capitalize shrink-0 transition-colors ${
                  platformFilter === p
                    ? 'bg-orange-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {filteredAccounts.length === 0 ? (
          <div className="py-12 text-center text-xs text-zinc-500">
            {accounts.length === 0
              ? 'No social accounts loaded. Add a Zernio key and click "Sync Accounts" above.'
              : `No accounts matching filter "${platformFilter}".`}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {filteredAccounts.map((acc) => (
              <div
                key={acc.id}
                className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg flex items-center gap-3 text-xs"
              >
                {acc.avatar_url ? (
                  <img
                    src={acc.avatar_url}
                    alt={acc.name}
                    className="w-9 h-9 rounded-full object-cover border border-zinc-700 shrink-0"
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center font-bold text-xs text-zinc-300 uppercase shrink-0">
                    {acc.platform.slice(0, 2)}
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-zinc-200 truncate">{acc.name}</span>
                    <span className="text-[9px] uppercase px-1.5 py-0.2 rounded font-bold bg-zinc-800 text-orange-400">
                      {acc.platform}
                    </span>
                  </div>
                  <span className="text-[11px] text-zinc-400 truncate block">@{acc.username}</span>
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-500">
                    <span>Key: {acc.key_label}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
