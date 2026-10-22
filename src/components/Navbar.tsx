import React from 'react';
import {
  LayoutDashboard,
  PlusCircle,
  Users,
  Clock,
  History,
  Settings,
  LogOut,
  Radio,
  ExternalLink
} from 'lucide-react';

export type TabType = 'dashboard' | 'create' | 'accounts' | 'queue' | 'history' | 'settings';

interface NavbarProps {
  currentTab: TabType;
  onSelectTab: (tab: TabType) => void;
  onLogout: () => void;
  accountCount: number;
  queueCount: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  onLogout,
  accountCount,
  queueCount
}) => {
  const tabs = [
    { id: 'dashboard' as TabType, label: 'Dashboard', icon: LayoutDashboard },
    { id: 'create' as TabType, label: 'Create', icon: PlusCircle },
    { id: 'accounts' as TabType, label: 'Accounts', icon: Users, badge: accountCount },
    { id: 'queue' as TabType, label: 'Queue', icon: Clock, badge: queueCount },
    { id: 'history' as TabType, label: 'History', icon: History },
    { id: 'settings' as TabType, label: 'Settings', icon: Settings },
  ];

  return (
    <header className="sticky top-0 z-40 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 text-white">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-orange-600 flex items-center justify-center font-black tracking-wider text-white text-base shadow-sm shadow-orange-950">
            SR
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-base tracking-tight text-zinc-100">SALT RELAY</span>
              <span className="text-[10px] uppercase font-semibold bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
                MOTIONSALT
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>D1 Cloudflare Connected</span>
            </div>
          </div>
        </div>

        {/* Desktop Nav */}
        <nav className="hidden md:flex items-center gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
                {typeof tab.badge === 'number' && tab.badge > 0 && (
                  <span className="px-1.5 py-0.2 bg-zinc-700 text-zinc-200 rounded text-[10px]">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User / Actions */}
        <div className="flex items-center gap-2">
          <a
            href="https://salt-relay.pages.dev"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded border border-zinc-800 bg-zinc-900"
          >
            <span>Live Pages</span>
            <ExternalLink className="w-3 h-3" />
          </a>
          <button
            onClick={onLogout}
            title="Log out"
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-red-400 px-2.5 py-1.5 rounded border border-zinc-800 hover:border-red-900/50 bg-zinc-900 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>

      {/* Mobile Sticky Bottom Tab Bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-zinc-950/95 border-t border-zinc-800 px-2 py-1.5 flex justify-around">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = currentTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`flex flex-col items-center justify-center p-1.5 rounded-lg text-[10px] font-medium transition-colors relative ${
                active ? 'text-orange-400 font-semibold' : 'text-zinc-400'
              }`}
            >
              <Icon className="w-4 h-4 mb-0.5" />
              <span>{tab.label}</span>
              {typeof tab.badge === 'number' && tab.badge > 0 && (
                <span className="absolute top-1 right-2 w-3.5 h-3.5 bg-orange-600 text-white rounded-full text-[9px] flex items-center justify-center font-bold">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </header>
  );
};
