// This file is now at api/index.js

const express = require('express');
const app = express();

// Middleware
app.use(express.json());

// NOTE: We REMOVED app.use(express.static('public'));
// Vercel handles this automatically if 'public' is in the root.

// NOTE: We REMOVED all WebSocket (ws) and http server code.
// Vercel does not support it.

// NOTE: We REMOVED in-memory storage.
// This will not work on Vercel. You must use a database.
// For now, we just return static data for the API.
const channels = {
    general: [],
    random: [],
    gaming: []
};

// --- REST API endpoints ---
// These will work on Vercel.

// Add the homepage route we discussed
app.get('/', (req, res) => {
    res.send('The API is running, but WebSockets are not supported on Vercel.');
});

app.get('/api/channels', (req, res) => {
    res.json({
        channels: Object.keys(channels)
    });
});

app.get('/api/channels/:channel/messages', (req, res) => {
    const { channel } = req.params;
    
    if (channels[channel]) {
        res.json({ messages: channels[channel] }); // Will always be empty
    } else {
        res.status(404).json({ error: 'Channel not found' });
    }
});

app.post('/api/channels', (req, res) => {
    // This won't actually save (see note above), but the API endpoint works
    const { name } = req.body;
    
    if (!name || channels[name]) {
        return res.status(400).json({ error: 'Invalid or duplicate channel name' });
    }
    
    channels[name] = []; // This will be forgotten immediately
    res.json({ success: true, channel: name });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        users: 0, // Cannot track users
        channels: Object.keys(channels).length
    });
});

// NOTE: We REMOVED server.listen(PORT, ...);
// This is the most important change for Vercel.

// Export the app for Vercel
module.exports = app;
