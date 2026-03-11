import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('electron', {
    // Add handles if needed
});
