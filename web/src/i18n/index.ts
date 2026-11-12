import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import nl from './nl.json';

export const languages = ['en', 'nl'] as const;
export type Language = (typeof languages)[number];

function initial(): Language {
  try {
    const stored = localStorage.getItem('restream.lang');
    if (stored === 'en' || stored === 'nl') return stored;
  } catch { /* storage unavailable */ }
  return navigator.language?.toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, nl: { translation: nl } },
  lng: initial(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLanguage(lang: Language) {
  try { localStorage.setItem('restream.lang', lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
  return i18n.changeLanguage(lang);
}

export default i18n;
