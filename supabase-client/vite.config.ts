import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// This dev harness exists to run and verify the auth foundation
// (LoginPage/App) in a real browser — it is not the future ERP frontend.
// A different port from client/ (5173) so both can run side by side.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
  },
});
