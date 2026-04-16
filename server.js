const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Set up trust proxy for accurate IP logging if hosted behind Cloudflare / Render
app.set('trust proxy', true);

// -------------------------------------------------------------
// IN-MEMORY DATABASES (Multi-Tenant Architecture)
// -------------------------------------------------------------
// We store bins in memory. In a fully-persisted app, you'd swap this object for MongoDB/Redis.
// Data Structure:
// bins = {
//   "bin-id-xyz": {
//     createdAt: 167...,
//     endpoints: { "GET-/test": { ... } },
//     history: [ { ... } ]
//   }
// }
const bins = {};

const MAX_HISTORY_PER_BIN = 100;
const BIN_EXPIRY_MS = 24 * 60 * 60 * 1000; // Auto-delete bins after 24 hours array

// Cleanup cronjob to prevent memory leaks in production
setInterval(() => {
    const now = Date.now();
    for (const binId in bins) {
        if (now - bins[binId].createdAt > BIN_EXPIRY_MS) {
            delete bins[binId];
        }
    }
}, 60 * 60 * 1000); // Check every hour

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------

function generateRandomData() {
    const types = ['string', 'number', 'boolean', 'object', 'array'];
    const type = types[Math.floor(Math.random() * types.length)];
    switch (type) {
        case 'string': return Math.random().toString(36).substring(7);
        case 'number': return Math.floor(Math.random() * 1000);
        case 'boolean': return Math.random() > 0.5;
        case 'object': return { key: `mock_value_${Math.floor(Math.random() * 100)}`, id: Math.floor(Math.random() * 1000) };
        case 'array': return [1, 2, 3, 4, 5].map(() => Math.floor(Math.random() * 100));
    }
}

// Middleware to get or initialize a bin
function getOrCreateBin(binId) {
    if (!bins[binId]) {
        bins[binId] = {
            createdAt: Date.now(),
            endpoints: {},
            history: []
        };
    }
    return bins[binId];
}

// -------------------------------------------------------------
// DASHBOARD API (For the frontend app)
// -------------------------------------------------------------

// 1. Claim a new bin or validate existing
app.post('/api/bins', (req, res) => {
    let { binId } = req.body;
    
    // If user provided a custom binId, try to use it. Clean it to be safe.
    if (binId) {
        binId = binId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    }
    
    // If no binId, or it was invalid, generate a random one
    if (!binId) {
        binId = crypto.randomBytes(4).toString('hex'); // e.g. "a1b2c3d4"
    }

    // Initialize it so we have a creation date
    getOrCreateBin(binId);

    // Return the server's public base URL so the frontend knows where it is hosted
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;

    res.json({ binId, baseUrl });
});

// Middleware to inject the active bin details into the request
function requireBin(req, res, next) {
    const binId = req.params.binId || req.headers['x-bin-id'];
    if (!binId) return res.status(400).json({ error: 'Missing bin context' });
    req.binId = binId.toLowerCase();
    req.bin = getOrCreateBin(req.binId);
    next();
}

// 2. Dashboard Endpoints Routes
app.get('/api/b/:binId/endpoints', requireBin, (req, res) => {
    res.json(Object.values(req.bin.endpoints));
});

app.post('/api/b/:binId/endpoints', requireBin, (req, res) => {
    const { method, path, responseStatus, responseBody, useRandom } = req.body;
    const id = Date.now().toString();
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    const key = `${method}-${cleanPath}`;
    
    req.bin.endpoints[key] = {
        id,
        method,
        path: cleanPath,
        responseStatus: parseInt(responseStatus) || 200,
        responseBody: responseBody || '{}',
        useRandom: !!useRandom,
        key
    };
    res.json({ success: true, endpoint: req.bin.endpoints[key] });
});

app.delete('/api/b/:binId/endpoints/:id', requireBin, (req, res) => {
    const { id } = req.params;
    for (const key in req.bin.endpoints) {
        if (req.bin.endpoints[key].id === id) {
            delete req.bin.endpoints[key];
            return res.json({ success: true });
        }
    }
    res.status(404).json({ error: 'Endpoint not found' });
});

app.get('/api/b/:binId/history', requireBin, (req, res) => {
    res.json(req.bin.history);
});

app.delete('/api/b/:binId/history', requireBin, (req, res) => {
    req.bin.history = [];
    res.json({ success: true });
});

// -------------------------------------------------------------
// THE MOCK INTERCEPTOR API
// -------------------------------------------------------------

// Path looks like /b/:binId/... (/b/a1b2c3d4/my/test/api)
app.all('/b/:binId/*', (req, res) => {
    const binId = req.params.binId.toLowerCase();
    const bin = getOrCreateBin(binId);

    // Extract the requested mock path after the binId
    // req.path includes the full path like /b/uuid/users/1
    // We strip off /b/uuid part to get /users/1
    const prefixLength = `/b/${binId}`.length;
    const requestPath = req.path.substring(prefixLength) || '/';
    const method = req.method;
    const key = `${method}-${requestPath}`;

    // Record the live request history
    const historyEntry = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        method,
        path: requestPath,
        headers: req.headers,
        body: req.body,
        query: req.query,
        ip: req.ip
    };
    
    bin.history.unshift(historyEntry);
    if (bin.history.length > MAX_HISTORY_PER_BIN) bin.history.pop();

    // Check if the mock rule exists
    const endpoint = bin.endpoints[key];

    if (endpoint) {
        let returnBody = endpoint.responseBody;
        if (endpoint.useRandom) {
            returnBody = JSON.stringify({
                data: generateRandomData(),
                message: `Dynamic generated payload from Freeceptor`,
                timestamp: new Date().toISOString()
            });
        }
        res.status(endpoint.responseStatus).type('json').send(returnBody);
    } else {
        // Wildcard fallback response so tests never hard-fail unnecessarily
        res.status(200).json({
            message: "Success! Freeceptor captured your request, but no mock rule was found.",
            dynamicId: Math.random().toString(36).substring(7),
            requestedMethod: method,
            requestedPath: requestPath,
            status: "success",
            timestamp: new Date().toISOString(),
            tip: `Go to your dashboard to define the rule for [${method}] ${requestPath}`
        });
    }
});

// Start the app
app.listen(PORT, () => {
    console.log(`Freeceptor running on http://localhost:${PORT}`);
});
