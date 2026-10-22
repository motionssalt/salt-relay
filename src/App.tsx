/**
 * Salt Relay — Unified Social Publishing Dashboard
 * Built for Victor (MOTIONSALT)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Navbar, TabType } from './components/Navbar.tsx';
import { LoginModal } from './components/LoginModal.tsx';
import { DashboardTab } from './components/DashboardTab.tsx';
import { CreatePostTab } from './components/CreatePostTab.tsx';
import { AccountsTab } from './components/AccountsTab.tsx';
import { QueueTab } from './components/QueueTab.tsx';
import { HistoryTab } from './components/HistoryTab.tsx';
import { SettingsTab } from './components/SettingsTab.tsx';

import { Job, ConnectedAccount, ZernioKey, PlatformCapability } from './types.ts';
import { api, clearSessionToken, getSessionToken } from './api.ts';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [currentTab, setCurrentTab] = useState<TabType>('dashboard');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [keys, setKeys] = useState<ZernioKey[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, PlatformCapability>>({});
  const [loading, setLoading] = useState<boolean>(false);

  // Check login
  const verifyAuth = useCallback(async () => {
    const token = getSessionToken();
    if (!token) {
      setIsAuthenticated(false);
      setAuthChecking(false);
      return;
    }
    try {
      const res = await api.checkAuth();
      setIsAuthenticated(Boolean(res.authenticated));
    } catch (e) {
      setIsAuthenticated(false);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsRes, accsRes, keysRes, capsRes] = await Promise.allSettled([
        api.getJobs(),
        api.getAccounts(),
        api.getKeys(),
        api.getCapabilities()
      ]);

      if (jobsRes.status === 'fulfilled' && jobsRes.value.jobs) {
        setJobs(jobsRes.value.jobs);
      }
      if (accsRes.status === 'fulfilled' && accsRes.value.accounts) {
        setAccounts(accsRes.value.accounts);
      }
      if (keysRes.status === 'fulfilled' && keysRes.value.keys) {
        setKeys(keysRes.value.keys);
      }
      if (capsRes.status === 'fulfilled' && capsRes.value.platforms) {
        setCapabilities(capsRes.value.platforms);
      }
    } catch (err) {
      console.error('Error loading data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    verifyAuth();

    const handleExpired = () => setIsAuthenticated(false);
    window.addEventListener('auth-expired', handleExpired);
    return () => window.removeEventListener('auth-expired', handleExpired);
  }, [verifyAuth]);

  useEffect(() => {
    if (isAuthenticated) {
      loadData();
    }
  }, [isAuthenticated, loadData]);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch (e) {}
    clearSessionToken();
    setIsAuthenticated(false);
  };

  const queuedCount = jobs.filter(j => j.status === 'scheduled' || j.status === 'pending').length;

  // Unauthenticated screen: render ONLY the login modal
  if (!isAuthenticated && !authChecking) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4">
        <LoginModal onSuccess={() => { setIsAuthenticated(true); loadData(); }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-orange-600 selection:text-white">
      <Navbar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        onLogout={handleLogout}
        accountCount={accounts.length}
        queueCount={queuedCount}
      />

      <main className="max-w-6xl mx-auto px-4 py-6">
        {currentTab === 'dashboard' && (
          <DashboardTab
            jobs={jobs}
            accounts={accounts}
            keys={keys}
            onNavigate={setCurrentTab}
            onRefresh={loadData}
            loading={loading}
          />
        )}

        {currentTab === 'create' && (
          <CreatePostTab
            accounts={accounts}
            capabilities={capabilities}
            onPostCreated={() => {
              loadData();
              setCurrentTab('queue');
            }}
          />
        )}

        {currentTab === 'accounts' && (
          <AccountsTab
            accounts={accounts}
            keys={keys}
            onRefresh={loadData}
            loading={loading}
          />
        )}

        {currentTab === 'queue' && (
          <QueueTab
            onNavigate={setCurrentTab}
            onRefresh={loadData}
          />
        )}

        {currentTab === 'history' && (
          <HistoryTab
            jobs={jobs}
            onRefresh={loadData}
            loading={loading}
          />
        )}

        {currentTab === 'settings' && (
          <SettingsTab />
        )}
      </main>
    </div>
  );
}
