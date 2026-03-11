import { app, BrowserWindow, session, screen } from 'electron';
import path from 'path';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

app.commandLine.appendSwitch('enable-speech-input');
app.commandLine.appendSwitch('allow-file-access-from-files');
app.commandLine.appendSwitch('ignore-certificate-errors'); // For potential proxy issues with model download
app.commandLine.appendSwitch('no-sandbox'); // Sometimes needed for WASM in Electron

const createWindow = () => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width } = primaryDisplay.workAreaSize;
    const windowWidth = 340;
    const windowHeight = 160;

    const mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        x: Math.round(width / 2 - windowWidth / 2),
        y: 20,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false, // fixed small size
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            devTools: false, // Turned off for production
            backgroundThrottling: false,
            webSecurity: false
        },
    });

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[Renderer] ${message}`);
    });

    // Force Chrome User-Agent to resolve "Network Error" in Speech API
    mainWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');


    mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
        if (permission === 'media') return true;
        return false;
    });

    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') callback(true);
        else callback(false);
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }
};

app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
