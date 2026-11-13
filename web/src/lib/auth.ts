import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type Me } from './api';
import { setLanguage } from '../i18n';
import { getTheme, setTheme } from './theme';
import i18n from '../i18n';

export function useMe() {
  const q = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/auth/me'), staleTime: 30_000 });
  // The signed-in user's language preference wins over the browser default.
  useEffect(() => {
    const lang = q.data?.user?.language;
    if (lang && lang !== i18n.language) setLanguage(lang);
  }, [q.data?.user?.language]);
  // Likewise the theme: the account's choice follows the user to every browser.
  useEffect(() => {
    const theme = q.data?.user?.theme;
    if (theme && theme !== getTheme()) setTheme(theme);
  }, [q.data?.user?.theme]);
  return q;
}

export function useRefreshMe() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['me'] });
}
