import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        ssr: true,
        rollupOptions: {
            input: 'src/main.ts',
        },
    },
});
