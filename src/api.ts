const TOKEN_KEY = 'salt_relay_session';
const WORKER_FALLBACK = 'https://salt-relay-api.motionssalt.workers.dev';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    // On Cloudflare Pages or any external production domain, use the live Cloudflare Worker API
    if (host.includes('pages.dev') || (!host.includes('run.app') && host !== 'localhost' && host !== '127.0.0.1')) {
      return WORKER_FALLBACK;
    }
  }
  return '';
}

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(options.headers as Record<string, string> || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const base = getApiBaseUrl();
  let targetUrl = endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`;

  let res: Response;
  try {
    res = await fetch(targetUrl, {
      credentials: 'include',
      ...options,
      headers
    });
  } catch (err: any) {
    // If worker request failed, try fallback
    if (!targetUrl.startsWith(WORKER_FALLBACK) && !endpoint.startsWith('http')) {
      targetUrl = `${WORKER_FALLBACK}${endpoint}`;
      res = await fetch(targetUrl, { credentials: 'include', ...options, headers });
    } else {
      throw new Error(err.message || 'Network request failed');
    }
  }

  let rawText = await res.text();

  // If we received an HTML response or empty response from a static host, fallback directly to the Worker
  if ((rawText.trim().startsWith('<!doctype') || rawText.trim().startsWith('<html') || !rawText.trim()) && !targetUrl.startsWith(WORKER_FALLBACK)) {
    try {
      const fallbackUrl = `${WORKER_FALLBACK}${endpoint}`;
      res = await fetch(fallbackUrl, { ...options, headers });
      rawText = await res.text();
    } catch {}
  }

  // Session expiry check (do not trigger for login or check)
  if (res.status === 401 && !endpoint.includes('/api/auth/login') && !endpoint.includes('/api/auth/check')) {
    clearSessionToken();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('auth-expired'));
    }
    throw new Error('Session expired. Please sign in again.');
  }

  // Parse JSON safely
  let data: any = {};
  if (rawText && rawText.trim().length > 0) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: rawText.length > 200 ? `Unexpected response (HTTP ${res.status})` : rawText };
    }
  }

  if (!res.ok) {
    throw new Error(data.error || `HTTP error ${res.status}`);
  }

  return data as T;
}

export const api = {
  login: (password: string) =>
    apiFetch<{ success: boolean; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    }),

  checkAuth: async () => {
    try {
      const token = getSessionToken();
      if (!token) return { authenticated: false };
      const res = await apiFetch<{ authenticated: boolean }>('/api/auth/check');
      return { authenticated: res.authenticated === true };
    } catch {
      return { authenticated: false };
    }
  },

  logout: () =>
    apiFetch<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),

  getKeys: () =>
    apiFetch<{ keys: any[] }>('/api/keys'),

  addKey: (label: string, key: string) =>
    apiFetch<{ success: boolean; key: any }>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ label, key })
    }),

  deleteKey: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),

  getAccounts: () =>
    apiFetch<{ accounts: any[] }>('/api/accounts'),

  syncAccounts: () =>
    apiFetch<{ success: boolean; total_accounts_synced: number; errors?: any[] }>('/api/accounts/sync', {
      method: 'POST'
    }),

  getCapabilities: () =>
    apiFetch<{ platforms: Record<string, any> }>('/api/capabilities'),

  inspectDriveOrLink: (url: string) =>
    apiFetch<{ success: boolean; files: any[]; error?: string }>('/api/drive/inspect', {
      method: 'POST',
      body: JSON.stringify({ url })
    }),

  getJobs: (status?: string) =>
    apiFetch<{ jobs: any[] }>(`/api/jobs${status ? `?status=${status}` : ''}`),

  getJobDetails: (id: string) =>
    apiFetch<{ job: any; sources?: any[]; media: any[]; destinations: any[]; logs: any[]; events?: any[] }>(`/api/jobs/${id}`),

  createJob: (payload: {
    caption: string;
    hashtags?: string;
    links: string[];
    publish_mode: 'now' | 'queue' | 'schedule';
    scheduled_at?: string;
    timezone?: string;
    story_enabled?: boolean;
    selected_destinations?: string[];
    dry_run?: boolean;
  }) =>
    apiFetch<{
      success: boolean;
      job_id: string;
      publish_mode?: string;
      status?: string;
      scheduled_at?: string;
      workflow_run_id?: string | null;
      workflow_run_url?: string | null;
    }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  retryJob: (id: string) =>
    apiFetch<{
      success: boolean;
      attempt?: number;
      mode?: 'reused_verified_assets' | 're_dispatched_workflow';
      workflow_run_id?: string | null;
      workflow_run_url?: string | null;
      message: string;
    }>(`/api/jobs/${id}/retry`, { method: 'POST' }),

  cancelJob: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  getQueue: () =>
    apiFetch<{ config: any; queued_jobs: any[]; next_available_slot: string }>('/api/queue'),

  updateQueueSettings: (settings: any) =>
    apiFetch<{ success: boolean }>('/api/queue/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    }),

  getSystemStatus: () =>
    apiFetch<any>('/api/system/status')
};
