const Location = require("../models/Location");

// Slugs that were hardcoded in server.js before locations moved into the
// database. Kept as a FALLBACK so live tents keep working until each one has
// a Location document. A slug stops using this fallback the moment it has a
// document, so deactivating it in the database really does reject it
const LEGACY_LOCATIONS = [
    "durban_north", "namibia", "sweet_waters", "qachas_nek_1", "sweetwaters_tunnel"
];

// locationId -> { active } for every registered location. Held in memory so
// the ingestion routes (hit every ~30s by every tent) never wait on a query
let registered = new Map();

async function refresh() {
    try {
        const rows = await Location.find({ role: "location" }, { locationId: 1, active: 1 }).lean();
        registered = new Map(rows.map((r) => [r.locationId, { active: r.active !== false }]));
    } catch (err) {
        // Keep the previous cache: a database hiccup must never stop Sensor Data
        console.error("Location registry refresh Failed, keeping previous Cache:", err.message);
    }
}

// Loads once now, then every 30s. Admin routes also call refresh() after
// each change so edits apply instantly
function startAutoRefresh(intervalMs = 30000) {
    refresh();
    setInterval(refresh, intervalMs).unref();
}

const normalise = (id) => (typeof id === "string" ? id.toLowerCase() : "");

function isValid(id) {
    const key = normalise(id);
    if (!key) return false;
    const entry = registered.get(key);
    if (entry) return entry.active;
    return LEGACY_LOCATIONS.includes(key);
}

function isInactive(id) {
    const entry = registered.get(normalise(id));
    return !!entry && !entry.active;
}

function listIds() {
    const ids = new Set(LEGACY_LOCATIONS.filter((id) => !registered.has(id)));
    for (const [id, entry] of registered) if (entry.active) ids.add(id);
    return [...ids].sort();
}

module.exports = { LEGACY_LOCATIONS, refresh, startAutoRefresh, isValid, isInactive, listIds };