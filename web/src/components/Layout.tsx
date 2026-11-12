import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  LayoutGrid, KeyRound, Share2, CalendarClock, CircleDot, BarChart3, MessageSquare, Link2,
  Users, Mail, DatabaseBackup, RefreshCw, Settings, ScrollText, Info, LogOut, Menu, X,
} from 'lucide-react';
import { api, type SystemInfo } from '../lib/api';
import { useMe } from '../lib/auth';
import { setLanguage } from '../i18n';
import { Logo } from './ui';
import { InfoDialog } from './InfoDialog';

interface Item { to: string; label: string; icon: ReactNode; soon?: boolean; admin?: boolean }

export function Layout() {
  const { t, i18n } = useTranslation();
  const me = useMe().data!;
  const user = me.user!;
  const isAdmin = user.role === 'admin';
  const qc = useQueryClient();
  const nav = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [info, setInfo] = useState(false);
  const sys = useQuery({ queryKey: ['info'], queryFn: () => api<SystemInfo>('/api/system/info') });

  const broadcast: Item[] = [
    { to: '/', label: t('nav.dashboard'), icon: <LayoutGrid size={18} /> },
    { to: '/streams', label: t('nav.streams'), icon: <KeyRound size={18} /> },
    { to: '/destinations', label: t('nav.destinations'), icon: <Share2 size={18} /> },
    { to: '/accounts', label: t('nav.accounts'), icon: <Link2 size={18} /> },
    { to: '/events', label: t('nav.events'), icon: <CalendarClock size={18} /> },
    { to: '/recordings', label: t('nav.recordings'), icon: <CircleDot size={18} /> },
    { to: '/analytics', label: t('nav.analytics'), icon: <BarChart3 size={18} /> },
    { to: '/chat', label: t('nav.chat'), icon: <MessageSquare size={18} /> },
  ];
  const admin: Item[] = [
    { to: '/admin/users', label: t('nav.users'), icon: <Users size={18} />, admin: true },
    { to: '/admin/mail', label: t('nav.mail'), icon: <Mail size={18} />, admin: true },
    { to: '/admin/backups', label: t('nav.backups'), icon: <DatabaseBackup size={18} />, admin: true },
    { to: '/admin/updates', label: t('nav.updates'), icon: <RefreshCw size={18} />, admin: true },
    { to: '/admin/settings', label: t('nav.settings'), icon: <Settings size={18} />, admin: true },
    { to: '/admin/audit', label: t('nav.audit'), icon: <ScrollText size={18} />, admin: true },
  ].filter((i) => !i.admin || isAdmin);

  async function switchLang() {
    const next = i18n.language === 'nl' ? 'en' : 'nl';
    await setLanguage(next);
    api('/api/auth/me', { method: 'PATCH', body: { language: next } }).then(() => qc.invalidateQueries({ queryKey: ['me'] })).catch(() => {});
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    qc.clear();
    nav('/login');
  }

  const channel = sys.data?.channel;
  const initials = (user.name || user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');

  const navList = (items: Item[]) => items.map((i) => (
    <NavLink
      key={i.to} to={i.to} end={i.to === '/'} onClick={() => setDrawer(false)}
      className={({ isActive }) => clsx(
        'flex min-h-10 items-center gap-3 rounded-[10px] px-3 text-sm transition-colors',
        isActive ? 'bg-surface-2 text-fg shadow-[inset_2px_0_0_var(--rs-accent)]' : 'text-fg-2 hover:bg-surface-2/60 hover:text-fg',
      )}
    >
      <span className="text-fg-3 [.active_&]:text-accent">{i.icon}</span>
      <span className="flex-1 truncate">{i.label}</span>
      {i.soon && <span className="font-mono text-[10px] tracking-wider text-fg-3 uppercase">{t('nav.soon')}</span>}
    </NavLink>
  ));

  const sidebar = (
    <nav aria-label="Main menu" className="flex h-full flex-col gap-6 overflow-y-auto border-r border-line bg-surface px-4 py-5">
      <div className="flex items-center gap-3 px-1">
        <Logo />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-display text-[17px] font-bold tracking-[0.04em]">{me.instanceName === 'Restream' ? 'RESTREAM' : me.instanceName}</span>
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-3 uppercase">{t('app.tagline')}</span>
        </div>
        <button className="ml-auto rounded-lg p-1.5 text-fg-3 hover:text-fg lg:hidden" onClick={() => setDrawer(false)} aria-label={t('nav.close')}><X size={20} /></button>
      </div>
      <div className="flex flex-col gap-1">
        <span className="eyebrow mb-1.5 px-3">{t('nav.broadcast')}</span>
        {navList(broadcast)}
      </div>
      {admin.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="eyebrow mb-1.5 px-3">{t('nav.administration')}</span>
          {navList(admin)}
        </div>
      )}
      <div className="mt-auto flex flex-col gap-3">
        <div role="group" aria-label={t('channel.label')} className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-bg p-1">
          {(['production', 'test'] as const).map((c) => (
            <button
              key={c}
              disabled={!isAdmin}
              onClick={() => { if (c !== channel) { setDrawer(false); nav(`/admin/updates?switch=${c}`); } }}
              aria-pressed={channel === c}
              className={clsx(
                'flex min-h-8 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-colors',
                channel === c ? 'bg-surface-2 text-fg' : 'text-fg-3 enabled:hover:text-fg-2',
              )}
            >
              {channel === c && <span className={clsx('size-1.5 rounded-full', c === 'production' ? 'bg-ok' : 'bg-warn')} />}
              {t(`channel.${c}`)}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <button onClick={() => setInfo(true)} className="flex min-h-10 items-center gap-2 rounded-xl border border-line px-3 text-sm text-fg-2 hover:border-line-strong hover:text-fg">
            <Info size={16} className="text-accent" /> {t('nav.info')} · <span className="font-mono text-xs text-fg-3">v{sys.data?.version ?? '…'}</span>
          </button>
          <button onClick={switchLang} aria-label={t('lang.switch')} className="min-h-10 rounded-xl border border-line px-3 font-mono text-xs text-fg-2 hover:border-line-strong">
            <span className={clsx(i18n.language === 'en' && 'text-accent')}>EN</span> · <span className={clsx(i18n.language === 'nl' && 'text-accent')}>NL</span>
          </button>
        </div>
        <div className="flex items-center gap-3 rounded-xl px-1 py-1">
          <NavLink to="/account" onClick={() => setDrawer(false)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 hover:bg-surface-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 font-mono text-xs text-accent">{initials}</div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{user.name || user.email}</span>
              <span className="text-xs text-fg-3">{t(`roles.${user.role}`)}</span>
            </div>
          </NavLink>
          <button onClick={logout} aria-label={t('nav.signOut')} title={t('nav.signOut')} className="rounded-lg p-2 text-fg-3 hover:bg-surface-2 hover:text-fg"><LogOut size={18} /></button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="grid-bg min-h-dvh lg:grid lg:grid-cols-[272px_1fr]">
      <aside className="sticky top-0 hidden h-dvh lg:block">{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-[86%] max-w-[300px]">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-col">
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-bg/85 px-4 py-3 backdrop-blur lg:hidden">
          <button onClick={() => setDrawer(true)} aria-label={t('nav.menu')} className="rounded-lg p-1.5 text-fg-2 hover:text-fg"><Menu size={22} /></button>
          <Logo size={30} />
          <span className="font-display font-bold tracking-[0.04em]">RESTREAM</span>
        </div>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </main>
      </div>
      <InfoDialog open={info} onClose={() => setInfo(false)} isAdmin={isAdmin} />
    </div>
  );
}
