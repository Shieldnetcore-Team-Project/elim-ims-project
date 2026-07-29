import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { UiProvider } from './lib/uiState';
import { CurrentUserProvider } from './lib/currentUser';
import { router } from './routes';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/components.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CurrentUserProvider>
      <UiProvider>
        <RouterProvider router={router} />
      </UiProvider>
    </CurrentUserProvider>
  </StrictMode>,
);
