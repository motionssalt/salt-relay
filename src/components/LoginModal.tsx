import React, { useState } from 'react';
import { Lock, ArrowRight, AlertCircle, Shield } from 'lucide-react';
import { api, setSessionToken } from '../api.ts';

interface LoginModalProps {
  onSuccess: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onSuccess }) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setError('Please enter your operator password.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(password.trim());
      if (res.success && res.token) {
        setSessionToken(res.token);
        onSuccess();
      } else {
        setError('Invalid password.');
      }
    } catch (err: any) {
      setError(err.message || 'Invalid password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-2xl p-6 text-zinc-100 shadow-2xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-11 h-11 rounded-xl bg-orange-600/15 border border-orange-500/30 flex items-center justify-center text-orange-400">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white tracking-tight">SALT RELAY</h2>
            <p className="text-xs text-zinc-400">Single-operator publishing access</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-950/70 border border-red-800/80 text-red-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="dashboard-password" className="block text-xs font-semibold text-zinc-300 mb-1.5">
              Dashboard Password
            </label>
            <input
              id="dashboard-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter operator password"
              autoComplete="current-password"
              className="w-full px-3.5 py-2.5 bg-zinc-950 border border-zinc-700/80 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500 transition-colors"
              autoFocus
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full py-2.5 px-4 bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-orange-600/20"
          >
            {loading ? (
              <span>Verifying...</span>
            ) : (
              <>
                <span>Enter Salt Relay</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-zinc-800/80 flex items-center justify-center gap-1.5 text-[11px] text-zinc-500">
          <Shield className="w-3.5 h-3.5 text-zinc-400" />
          <span>Encrypted operator session</span>
        </div>
      </div>
    </div>
  );
};
