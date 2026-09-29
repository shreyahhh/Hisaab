import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React + Vite dashboard (ADR-0010). TanStack Router + Query landed early (M1-9) to show real data
// for what M0-M1 built; TanStack Table, Recharts and Tailwind are still deferred to the M3-4 report
// screens.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
