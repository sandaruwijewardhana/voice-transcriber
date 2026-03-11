const { VitePlugin } = require('@electron-forge/plugin-vite');
const { MakerSquirrel } = require('@electron-forge/maker-squirrel');
const { MakerZIP } = require('@electron-forge/maker-zip');

module.exports = {
    packagerConfig: {
        executableName: 'VoiceTranscriber',
    },
    rebuildConfig: {},
    makers: [new MakerSquirrel({}), new MakerZIP({}, ['win32'])],
    plugins: [
        new VitePlugin({
            build: [
                {
                    entry: 'src/main.ts',
                    config: 'vite.main.config.mjs',
                },
                {
                    entry: 'src/preload.ts',
                    config: 'vite.preload.config.mjs',
                },
            ],
            renderer: [
                {
                    name: 'main_window',
                    config: 'vite.renderer.config.mjs',
                },
            ],
        }),
    ],
};
