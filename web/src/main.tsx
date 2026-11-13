import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';
import './i18n';
import './lib/theme';
import { App } from './App';
import { ApiError } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

// A 401 anywhere means the session ended: refresh "me" so the router sends the user to sign in.
queryClient.getQueryCache().subscribe((e) => {
  if (e.type === 'updated' && e.action.type === 'error' && e.action.error instanceof ApiError && e.action.error.status === 401 && e.query.queryKey[0] !== 'me') {
    queryClient.invalidateQueries({ queryKey: ['me'] });
  }
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
