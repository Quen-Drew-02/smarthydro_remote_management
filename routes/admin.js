const express = require("express");
const mongoose = require("mongoose");
const Sensor = require("../models/Sensor");
const Command = require("../models/Command");
const Location = require("../models/Location");
const registry = require("../utils/locationRegistry");
const { PIN_FORMAT, hashPin } = require("../utils/pin");
const { generatePin, isWeakPin, findPinOwner } = require("../utils/pinTools");

/**
 * Admin routes for the SmartHydro Admin app, mounted at /admin
 *
 */
const router = express.Router();

// Must mirror mapRemoteCommand() in the ESP32 firmware
const SUPPORTED_COMMANDS = [
    "light_on", "light_off", "fan_on", "fan_off", "pump_on", "pump_off",
    "extract_on", "extract_off", "ph_up", "ph_down", "ph_stop",
    "ec_up", "ec_down", "ec_stop", "calibrate_ec"
];

// Readings arrive roughly every 30s: under 2 min = online, under 10 = delayed.
const ONLINE_MS = 2 * 60 * 1000;
const DELAYED_MS = 10 * 60 * 1000;

const SLUG_FORMAT = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const isSlug = (s) => typeof s === "string" && s.length >= 3 && s.length <= 40 && SLUG_FORMAT.test(s);

// Turns a thrown error inside an async handler into a 500 response
const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => res.status(500).json({ error: err.message }));

function statusFor(lastAt) {
    if (!lastAt) return "no_data";
    const age = Date.now() - new Date(lastAt).getTime();
    return age < ONLINE_MS ? "online" : age < DELAYED_MS ? "delayed" : "offline";
}

// One location's row for the fleet list. `doc` is null for a legacy slug
// that has not been registered yet
async function buildRow(locationId, doc) {
    const latest = await Sensor.findOne({ locationId }).sort({ timestamp: -1 }).lean();
    return {
        locationId,
        displayName: doc && doc.displayName ? doc.displayName : null,
        registered: !!doc,
        active: doc ? doc.active !== false : true,
        updatedAt: doc ? doc.updatedAt : null,
        lastReadingAt: latest ? latest.timestamp : null,
        // Computed on the server so the app needs no date library and is immune
        // to a wrong device clock. The app adds the time elapsed since it fetched.
        lastReadingAgeSeconds: latest
            ? Math.max(0, Math.round((Date.now() - new Date(latest.timestamp).getTime()) / 1000))
            : null,
        status: statusFor(latest ? latest.timestamp : null),
        latestReading: latest
            ? {
                temperature: latest.Temperature, humidity: latest.Humidity, ph: latest.PH,
                ec: latest.EC, light: latest.Light, flowRate: latest.FlowRate
            }
            : null
    };
}

// Validates a supplied PIN, or generates a unique one. `excludeId` is the
// document being updated, so rotating a PIN doesn't collide with itself
async function resolvePin(supplied, excludeId) {
    const all = await Location.find({});
    const others = all.filter((d) => !excludeId || String(d._id) !== String(excludeId));

    if (supplied !== undefined) {
        if (typeof supplied !== "string" || !PIN_FORMAT.test(supplied)) return { error: "PIN must be exactly 6 digits" };
        if (isWeakPin(supplied)) return { error: "That PIN is too easy to guess" };
        if (await findPinOwner(supplied, others)) return { error: "That PIN is already in use" };
        return { pin: supplied, generated: false };
    }

    for (let i = 0; i < 20; i++) {
        const candidate = generatePin();
        if (!isWeakPin(candidate) && !(await findPinOwner(candidate, others))) {
            return { pin: candidate, generated: true };
        }
    }
    return { error: "Could not Generate a unique PIN, Please Try Again" };
}

// Connection test. Returns the database name so the app can show whether it is pointed at dev or production
router.get("/ping", (req, res) => {
    res.json({ ok: true, database: mongoose.connection.name, time: new Date().toISOString() });
});

// ---------- Locations ----------

router.get("/locations", wrap(async (req, res) => {
    const docs = await Location.find({ role: "location" });
    const byId = new Map(docs.map((d) => [d.locationId, d]));
    const ids = [...new Set([...byId.keys(), ...registry.LEGACY_LOCATIONS])].sort();
    const locations = await Promise.all(ids.map((id) => buildRow(id, byId.get(id))));
    res.json({ locations });
}));

router.get("/locations/:locationId", wrap(async (req, res) => {
    const locationId = req.params.locationId.toLowerCase();
    const doc = await Location.findOne({ role: "location", locationId });
    if (!doc && !registry.LEGACY_LOCATIONS.includes(locationId)) {
        return res.status(404).json({ error: "Unknown location" });
    }
    const row = await buildRow(locationId, doc);
    const recent = await Command.find({ locationId }).sort({ createdAt: -1 }).limit(10).lean();
    res.json({
        ...row,
        recentCommands: recent.map((c) => ({
            id: String(c._id), command: c.command, executed: c.executed === true,
            createdAt: c.createdAt, executedAt: c.executedAt || null
        }))
    });
}));

// Register a location (new, or a legacy slug that has no record yet).
// Body: { locationId, displayName?, pin? }. If pin is omitted one is
// generated and returned ONCE in the Response
router.post("/locations", wrap(async (req, res) => {
    const locationId = String(req.body.locationId || "").toLowerCase();
    const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";

    if (!isSlug(locationId)) {
        return res.status(400).json({ error: "locationId must be 3-40 characters: lowercase letters, digits and single underscores" });
    }
    if (displayName.length > 60) return res.status(400).json({ error: "displayName is too long" });
    if (await Location.exists({ role: "location", locationId })) {
        return res.status(409).json({ error: "That location is already registered" });
    }

    const resolved = await resolvePin(req.body.pin);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const doc = await Location.create({
        role: "location",
        locationId,
        displayName: displayName || undefined,
        pinHash: await hashPin(resolved.pin)
    });
    await registry.refresh();

    res.status(201).json({
        location: await buildRow(locationId, doc),
        ...(resolved.generated ? { pin: resolved.pin } : {})
    });
}));

// Rename and/or deactivate/reactivate. Body: { displayName?, active? }
router.patch("/locations/:locationId", wrap(async (req, res) => {
    const locationId = req.params.locationId.toLowerCase();
    const doc = await Location.findOne({ role: "location", locationId });
    if (!doc) return res.status(404).json({ error: "Location is not registered yet" });

    const { displayName, active } = req.body;
    if (displayName !== undefined) {
        if (typeof displayName !== "string" || displayName.trim().length > 60) {
            return res.status(400).json({ error: "Invalid displayName" });
        }
        doc.displayName = displayName.trim() || undefined; // empty string clears it
    }
    if (active !== undefined) {
        if (typeof active !== "boolean") return res.status(400).json({ error: "active must be true or false" });
        doc.active = active;
    }
    doc.updatedAt = new Date();
    await doc.save();
    await registry.refresh();

    res.json({ location: await buildRow(locationId, doc) });
}));

// Set or rotate a location's PIN. Body: { pin? } (omit to generate).
router.post("/locations/:locationId/pin", wrap(async (req, res) => {
    const locationId = req.params.locationId.toLowerCase();
    const doc = await Location.findOne({ role: "location", locationId });
    if (!doc) return res.status(404).json({ error: "Location is not registered yet" });

    const resolved = await resolvePin(req.body.pin, doc._id);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    doc.pinHash = await hashPin(resolved.pin);
    doc.updatedAt = new Date();
    await doc.save();

    res.json({ ok: true, ...(resolved.generated ? { pin: resolved.pin } : {}) });
}));

// ---------- Master PIN ----------

router.get("/master", wrap(async (req, res) => {
    const doc = await Location.findOne({ role: "master" });
    res.json({ exists: !!doc, updatedAt: doc ? doc.updatedAt : null });
}));

router.post("/master/pin", wrap(async (req, res) => {
    const existing = await Location.findOne({ role: "master" });
    const resolved = await resolvePin(req.body.pin, existing ? existing._id : undefined);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const pinHash = await hashPin(resolved.pin);
    if (existing) {
        existing.pinHash = pinHash;
        existing.updatedAt = new Date();
        await existing.save();
    } else {
        await Location.create({ role: "master", pinHash });
    }
    res.json({ ok: true, ...(resolved.generated ? { pin: resolved.pin } : {}) });
}));

// ---------- Commands ----------

router.get("/commands/supported", (req, res) => {
    res.json({ commands: SUPPORTED_COMMANDS });
});

// History, newest first. Query: locationId? limit? (1-200, default 50)
router.get("/commands", wrap(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const filter = {};
    if (req.query.locationId) filter.locationId = String(req.query.locationId).toLowerCase();

    const rows = await Command.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({
        commands: rows.map((c) => ({
            id: String(c._id), locationId: c.locationId, command: c.command,
            executed: c.executed === true, createdAt: c.createdAt, executedAt: c.executedAt || null
        }))
    });
}));

// ---------- Readings History (trend charts) ----------

// Query: locationId (required), hours (1-168, default 24), maxPoints (10-1000, default 288).
// Readings are thinned by a fixed stride so a week of data stays chart sized
router.get("/readings", wrap(async (req, res) => {
    const locationId = String(req.query.locationId || "").toLowerCase();
    if (!isSlug(locationId)) return res.status(400).json({ error: "locationId is required" });

    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 168);
    const maxPoints = Math.min(Math.max(parseInt(req.query.maxPoints, 10) || 288, 10), 1000);
    const since = new Date(Date.now() - hours * 3600 * 1000);

    const rows = await Sensor.find({ locationId, timestamp: { $gte: since } })
        .sort({ timestamp: 1 }).lean();

    const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
    const points = rows
        .filter((_, i) => i % stride === 0 || i === rows.length - 1) // always keep the newest
        .map((r) => ({
            t: r.timestamp, temperature: r.Temperature, humidity: r.Humidity,
            ph: r.PH, ec: r.EC, light: r.Light, flowRate: r.FlowRate
        }));

    res.json({ locationId, hours, count: points.length, points });
}));

module.exports = router;