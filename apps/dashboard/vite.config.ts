import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React + Vite dashboard (ADR-0010). TanStack Router/Query/Table, Recharts and Tailwind are
// added when the onboarding wizard and report screens are built (M3-4), not in this M0-1 scaffold.
export default defineConfig({
  plugins: [react()],
});
