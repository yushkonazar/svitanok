import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Тести Mini App (аудит C2: «нуль компонентних тестів»).
//
// НАВІЩО ОКРЕМИЙ РАННЕР, а не кореневий vitest. Кореневий живе в node-світі й
// уміє лише .ts — саме тому чиста логіка (plural, trendPath, demoBadge, схеми)
// покривається ЗВІДТИ і має там лишатись: це швидко й не потребує DOM. Тут
// перевіряється те, чого там перевірити неможливо: що компонент РЕНДЕРИТЬ і як
// поводиться при взаємодії.
//
// Межа проста: чиста функція -> кореневий vitest; JSX/хуки/події -> цей.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
