import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/token': 'http://localhost:3001',
      '/kick': 'http://localhost:3001',
      '/latency-threshold': 'http://localhost:3001',
      '/agent': 'http://localhost:3001',
    },
  }
});
