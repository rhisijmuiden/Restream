import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { useMe } from './lib/auth';
import { Layout } from './components/Layout';
import { Login, LoginMfa } from './pages/Login';
import { Setup2fa } from './pages/Setup2fa';
import { PasswordForm } from './pages/ChangePassword';
import { AuthShell } from './pages/AuthShell';
import { Dashboard } from './pages/Dashboard';
import { Streams } from './pages/Streams';
import { Destinations } from './pages/Destinations';
import { ComingSoon } from './pages/ComingSoon';
import { Users } from './pages/Users';
import { Account } from './pages/Account';
import { Settings } from './pages/Settings';
import { Updates } from './pages/Updates';
import { Audit } from './pages/Audit';
import { useRefreshMe } from './lib/auth';
import { Logo } from './components/ui';

function Splash() {
  return <div className="grid-bg flex min-h-dvh items-center justify-center"><div className="pulse-dot"><Logo size={48} /></div></div>;
}

/** Routes each session stage to the one screen it may see. */
function Gate({ children, need }: { children: ReactNode; need: 'anon' | 'mfa' | 'mfa_setup' | 'password' | 'full' | 'admin' }) {
  const { data, isLoading } = useMe();
  const loc = useLocation();
  if (isLoading || !data) return <Splash />;
  const stage = data.stage;
  const target =
    !stage ? '/login'
      : stage === 'mfa' ? '/login/2fa'
        : stage === 'mfa_setup' ? '/setup-2fa'
          : data.user?.must_change_password ? '/change-password'
            : null;
  if (need === 'anon') return target === '/login' ? <>{children}</> : <Navigate to={target ?? '/'} replace />;
  if (need === 'mfa' || need === 'mfa_setup' || need === 'password') {
    const own = need === 'mfa' ? '/login/2fa' : need === 'mfa_setup' ? '/setup-2fa' : '/change-password';
    return target === own ? <>{children}</> : <Navigate to={target ?? '/'} replace />;
  }
  if (target) return <Navigate to={target} replace state={{ from: loc.pathname }} />;
  if (need === 'admin' && data.user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function ForcedPassword() {
  const { t } = useTranslation();
  const refresh = useRefreshMe();
  return (
    <AuthShell>
      <div className="flex flex-col gap-5">
        <h2 className="font-display text-[22px] font-semibold">{t('changePassword.title')}</h2>
        <PasswordForm forced onDone={() => refresh()} />
      </div>
    </AuthShell>
  );
}

export function App() {
  const admin = (el: ReactNode) => <Gate need="admin">{el}</Gate>;
  return (
    <Routes>
      <Route path="/login" element={<Gate need="anon"><Login /></Gate>} />
      <Route path="/login/2fa" element={<Gate need="mfa"><LoginMfa /></Gate>} />
      <Route path="/setup-2fa" element={<Gate need="mfa_setup"><Setup2fa /></Gate>} />
      <Route path="/change-password" element={<Gate need="password"><ForcedPassword /></Gate>} />
      <Route element={<Gate need="full"><Layout /></Gate>}>
        <Route index element={<Dashboard />} />
        <Route path="streams" element={<Streams />} />
        <Route path="destinations" element={<Destinations />} />
        <Route path="events" element={<ComingSoon titleKey="nav.events" phase={3} />} />
        <Route path="recordings" element={<ComingSoon titleKey="nav.recordings" phase={3} />} />
        <Route path="analytics" element={<ComingSoon titleKey="nav.analytics" phase={4} />} />
        <Route path="chat" element={<ComingSoon titleKey="nav.chat" phase={4} />} />
        <Route path="account" element={<Account />} />
        <Route path="admin/users" element={admin(<Users />)} />
        <Route path="admin/mail" element={admin(<ComingSoon titleKey="nav.mail" phase={2} />)} />
        <Route path="admin/backups" element={admin(<ComingSoon titleKey="nav.backups" phase={2} />)} />
        <Route path="admin/updates" element={admin(<Updates />)} />
        <Route path="admin/settings" element={admin(<Settings />)} />
        <Route path="admin/audit" element={admin(<Audit />)} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
