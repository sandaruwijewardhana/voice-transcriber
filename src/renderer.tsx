import React from 'react';
import ReactDOM from 'react-dom/client';
import TranscriptionApp from './TranscriptionApp';

const rootElement = document.getElementById('root');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <React.StrictMode>
            <TranscriptionApp />
        </React.StrictMode>
    );
}
