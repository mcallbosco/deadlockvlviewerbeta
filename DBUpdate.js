// Counter client shim.
// Keeps the old Supabase-era globals, but sends batched hits to Cloudflare.

(function () {
    const COUNTERS_API_BASE = 'https://counters.mcallbos.co';
    const CACHE_TTL_MS = 5 * 60 * 1000;
    const FLUSH_DELAY_MS = 50;

    const legacyCounterAliases = {
        VLVVLDeadlockPlayed: 'site-deadlock-voiceline-plays',
        VLVVLOverwatchPlayed: 'site-overwatch-voiceline-plays',
        VLVVLApexPlayed: 'site-apex-voiceline-plays',
        VLVVLPlayed: 'total-voiceline-plays',
    };

    const virtualCounters = new Set(['total-voiceline-plays']);
    const counterCache = {};
    const pendingDeltas = {};
    let flushTimer = null;

    function normalizeCounterName(rowId) {
        if (typeof rowId !== 'string' || rowId.length === 0) return null;
        const aliased = legacyCounterAliases[rowId] || rowId;
        const normalized = aliased.trim().toLowerCase();
        return /^[a-z0-9-]{1,96}$/.test(normalized) ? normalized : null;
    }

    function scheduleFlush() {
        if (flushTimer !== null) return;
        flushTimer = window.setTimeout(flushCounterHits, FLUSH_DELAY_MS);
    }

    async function flushCounterHits() {
        flushTimer = null;
        const deltas = { ...pendingDeltas };
        for (const name of Object.keys(pendingDeltas)) {
            delete pendingDeltas[name];
        }
        if (Object.keys(deltas).length === 0) return;

        try {
            await fetch(`${COUNTERS_API_BASE}/v1/hits`, {
                method: 'POST',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deltas }),
            });
        } catch (error) {
            console.warn('[DBUpdate.js] Counter batch failed:', error);
        }
    }

    async function incrementCounterById(rowId) {
        const name = normalizeCounterName(rowId);
        if (!name || virtualCounters.has(name)) {
            return { data: null, error: null };
        }

        pendingDeltas[name] = (pendingDeltas[name] || 0) + 1;
        const cached = counterCache[name];
        if (cached) {
            cached.value += 1;
            cached.timestamp = Date.now();
        }
        scheduleFlush();
        return { data: cached ? cached.value : null, error: null };
    }

    async function getCounterValueById(rowId) {
        const name = normalizeCounterName(rowId);
        if (!name) {
            return { data: null, error: new Error('Invalid counter name') };
        }

        const now = Date.now();
        const cached = counterCache[name];
        if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
            return { data: cached.value, error: null };
        }

        try {
            const response = await fetch(`${COUNTERS_API_BASE}/v1/count/${encodeURIComponent(name)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            });
            if (!response.ok) {
                throw new Error(`Counter API returned ${response.status}`);
            }
            const payload = await response.json();
            const value = Number(payload && payload.count);
            if (!Number.isFinite(value)) {
                throw new Error('Counter API returned a non-numeric count');
            }
            counterCache[name] = { value, timestamp: now };
            return { data: value, error: null };
        } catch (error) {
            console.warn('[DBUpdate.js] Counter read failed:', error);
            return { data: null, error };
        }
    }

    // The old detailed telemetry is intentionally retired to keep Worker
    // request volume and stored rows low. Site-level counters remain.
    async function noopCounter() {
        return { data: null, error: null };
    }

    window.incrementCounterById = incrementCounterById;
    window.getCounterValueById = getCounterValueById;
    window.incrementVoiceline = noopCounter;
    window.incrementConversation = noopCounter;
    window.incrementCharacterForVersion = noopCounter;

    window.addEventListener('pagehide', flushCounterHits);
})();
