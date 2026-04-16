const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', true);

// -------------------------------------------------------------
// DATABASE SETUP (MongoDB vs In-Memory Fallback)
// -------------------------------------------------------------
let useMongo = false;

// Mongoose Schemas
const endpointSchema = new mongoose.Schema({
    binId: { type: String, required: true, index: true },
    method: String,
    path: String,
    responseStatus: Number,
    responseBody: String,
    useRandom: Boolean,
    key: String,
});
const Endpoint = mongoose.model('Endpoint', endpointSchema);

const historySchema = new mongoose.Schema({
    binId: { type: String, required: true, index: true },
    timestamp: { type: Date, default: Date.now },
    method: String,
    path: String,
    headers: Object,
    body: Object,
    query: Object,
    ip: String
});
const History = mongoose.model('History', historySchema);

if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(() => {
            console.log('✅ Connected to MongoDB Cloud');
            useMongo = true;
        })
        .catch(err => console.log('❌ MongoDB connection error:', err));
} else {
    console.log('⚠️ No MONGO_URI provided. Falling back to IN-MEMORY storage.');
}

// Memory Fallback
const bins = {};
const MAX_HISTORY_PER_BIN = 100;
const BIN_EXPIRY_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
    if (useMongo) return;
    const now = Date.now();
    for (const binId in bins) {
        if (now - bins[binId].createdAt > BIN_EXPIRY_MS) delete bins[binId];
    }
}, 60 * 60 * 1000);

function getOrCreateBinMemory(binId) {
    if (!bins[binId]) bins[binId] = { createdAt: Date.now(), endpoints: {}, history: [] };
    return bins[binId];
}

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

// -------------------------------------------------------------
// DASHBOARD API
// -------------------------------------------------------------
app.post('/api/bins', (req, res) => {
    let { binId } = req.body;
    if (binId) binId = binId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    if (!binId) binId = crypto.randomBytes(4).toString('hex');

    if (!useMongo) getOrCreateBinMemory(binId);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    res.json({ binId, baseUrl: `${protocol}://${host}` });
});

app.get('/api/b/:binId/endpoints', async (req, res) => {
    const binId = req.params.binId.toLowerCase();
    if (useMongo) {
        const eps = await Endpoint.find({ binId });
        res.json(eps.map(e => ({ ...e.toObject(), id: e._id })));
    } else {
        res.json(Object.values(getOrCreateBinMemory(binId).endpoints));
    }
});

app.post('/api/b/:binId/endpoints', async (req, res) => {
    const binId = req.params.binId.toLowerCase();
    const { method, path, responseStatus, responseBody, useRandom } = req.body;
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    const key = `${method}-${cleanPath}`;

    const data = { method, path: cleanPath, responseStatus: parseInt(responseStatus) || 200, responseBody: responseBody || '{}', useRandom: !!useRandom, key, binId };

    if (useMongo) {
        await Endpoint.findOneAndDelete({ binId, key }); // Prevent duplicate routes
        const ep = await Endpoint.create(data);
        res.json({ success: true, endpoint: { ...ep.toObject(), id: ep._id } });
    } else {
        const bin = getOrCreateBinMemory(binId);
        data.id = Date.now().toString();
        bin.endpoints[key] = data;
        res.json({ success: true, endpoint: bin.endpoints[key] });
    }
});

app.delete('/api/b/:binId/endpoints/:id', async (req, res) => {
    const binId = req.params.binId.toLowerCase();
    if (useMongo) {
        await Endpoint.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } else {
        const bin = getOrCreateBinMemory(binId);
        for (const k in bin.endpoints) {
            if (bin.endpoints[k].id === req.params.id) {
                delete bin.endpoints[k];
                return res.json({ success: true });
            }
        }
        res.status(404).json({ error: 'Not found' });
    }
});

app.get('/api/b/:binId/history', async (req, res) => {
    const binId = req.params.binId.toLowerCase();
    if (useMongo) {
        const history = await History.find({ binId }).sort({ timestamp: -1 }).limit(MAX_HISTORY_PER_BIN);
        res.json(history);
    } else {
        res.json(getOrCreateBinMemory(binId).history);
    }
});

app.delete('/api/b/:binId/history', async (req, res) => {
    const binId = req.params.binId.toLowerCase();
    if (useMongo) {
        await History.deleteMany({ binId });
    } else {
        getOrCreateBinMemory(binId).history = [];
    }
    res.json({ success: true });
});

// -------------------------------------------------------------
// THE MOCK INTERCEPTOR API
// -------------------------------------------------------------
app.all('/b/:binId/*', async (req, res) => {
    const binId = req.params.binId.toLowerCase();
    const prefixLength = `/b/${binId}`.length;
    const requestPath = req.path.substring(prefixLength) || '/';
    const method = req.method;
    const key = `${method}-${requestPath}`;

    const historyData = { binId, method, path: requestPath, headers: req.headers, body: req.body, query: req.query, ip: req.ip };

    let endpoint = null;
    
    if (useMongo) {
        // Run DB saving asynchronously so we don't block the mock response
        History.create(historyData).then(async () => {
             // Keep limits strictly
             const count = await History.countDocuments({ binId });
             if (count > MAX_HISTORY_PER_BIN) {
                 const oldest = await History.find({ binId }).sort({ timestamp: 1 }).limit(count - MAX_HISTORY_PER_BIN);
                 await History.deleteMany({ _id: { $in: oldest.map(o => o._id) } });
             }
        }).catch(err => console.log("History logging error", err));
        
        endpoint = await Endpoint.findOne({ binId, key });
    } else {
        const bin = getOrCreateBinMemory(binId);
        historyData.id = Date.now().toString();
        historyData.timestamp = new Date().toISOString();
        bin.history.unshift(historyData);
        if (bin.history.length > MAX_HISTORY_PER_BIN) bin.history.pop();
        
        endpoint = bin.endpoints[key];
    }

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
        res.status(200).json({
            message: "Success! Freeceptor captured your request, but no mock rule was found.",
            dynamicId: Math.random().toString(36).substring(7),
            requestedMethod: method,
            requestedPath: requestPath,
            status: "success",
            timestamp: new Date().toISOString()
        });
    }
});

// Start the app
app.listen(PORT, () => {
    console.log(`Freeceptor running on http://localhost:${PORT}`);
});
