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

// Every error carries a machine-readable `code` next to the English message,
// so the app can show it in the admin's own language.
const fail = (res, status, code, message) => res.status(status).json({ code, error: message });

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Sensor field in MongoDB for each metric key sent to the app
const METRIC_FIELDS = { temperature: "Temperature", humidity: "Humidity", ph: "PH", ec: "EC", light: "Light" };

function statusFor(lastAt) {
    if (!lastAt) return "no_data";
    const age = Date.now() - new Date(lastAt).getTime();
    return age < ONLINE_MS ? "online" : age < DELAYED_MS ? "delayed" : "offline";
}

// pending -> nobody has collected it; collected -> a tent picked it up;
// cancelled -> an admin cancelled it first. executedAt wins, so if a tent
// collected it in the instant a cancel arrived, it reads as collected.
function commandStatus(c) {
    if (c.cancelledAt && !c.executedAt) return "cancelled";
    return c.executed === true ? "collected" : "pending";
}

// Ages are computed on the server so the app needs no date library and a
// wrong device clock cannot skew them.
function shapeCommand(c) {
    const created = new Date(c.createdAt).getTime();
    return {
        id: String(c._id),
        locationId: c.locationId,
        command: c.command,
        status: commandStatus(c),
        createdAt: c.createdAt,
        executedAt: c.executedAt || null,
        cancelledAt: c.cancelledAt || null,
        ageSeconds: Math.max(0, Math.round((Date.now() - created) / 1000)),
        collectedAfterSeconds: c.executedAt
            ? Math.max(0, Math.round((new Date(c.executedAt).getTime() - created) / 1000))
            : null
    };
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

// Validates a Supplied PIN, or generates a unique one. `excludeId` is the
// document being updated, so rotating a PIN doesn't collide with itself.
// Failures carry the HTTP status and Error Code to Send back
async function resolvePin(supplied, excludeId) {
    const all = await Location.find({});
    const others = all.filter((d) => !excludeId || String(d._id) !== String(excludeId));

    if (supplied !== undefined) {
        if (typeof supplied !== "string" || !PIN_FORMAT.test(supplied)) {
            return { status: 400, code: "PIN_INVALID", error: "PIN must be exactly 6 Digits" };
        }
        if (isWeakPin(supplied)) {
            return { status: 400, code: "PIN_WEAK", error: "That PIN is too easy to Guess" };
        }
        if (await findPinOwner(supplied, others)) {
            return { status: 409, code: "PIN_IN_USE", error: "That PIN is already in Use" };
        }
        return { pin: supplied, generated: false };
    }

    for (let i = 0; i < 20; i++) {
        const candidate = generatePin();
        if (!isWeakPin(candidate) && !(await findPinOwner(candidate, others))) {
            return { pin: candidate, generated: true };
        }
    }
    return { status: 500, code: "PIN_GENERATION_FAILED", error: "Could not Generate a unique PIN, please Try Again" };
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
        recentCommands: recent.map(shapeCommand)
    });
}));

// Register a location (new, or a legacy slug that has no record yet).
// Body: { locationId, displayName?, pin? }. If pin is omitted one is
// generated and returned ONCE in the Response
router.post("/locations", wrap(async (req, res) => {
    const locationId = String(req.body.locationId || "").toLowerCase();
    const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";

    if (!isSlug(locationId)) {
        return fail(res, 400, "SLUG_INVALID", "locationId must be 3-40 characters: lowercase letters, digits and single underscores");
    }
    if (displayName.length > 60) return fail(res, 400, "NAME_TOO_LONG", "displayName is too Long");

    if (await Location.exists({ role: "location", locationId })) {
        return fail(res, 409, "LOCATION_EXISTS", "That location is already Registered");
    }

    const resolved = await resolvePin(req.body.pin);
    if (resolved.error) return fail(res, resolved.status, resolved.code, resolved.error);

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
    if (!doc) return fail(res, 404, "NOT_FOUND", "Location is not registered yet");

    const { displayName, active } = req.body;
    if (displayName !== undefined) {
        if (typeof displayName !== "string" || displayName.trim().length > 60) {
            return fail(res, 400, "NAME_TOO_LONG", "displayName must be text of at most 60 characters");
        }
        doc.displayName = displayName.trim() || undefined; // empty string clears it
    }
    if (active !== undefined) {
        if (typeof active !== "boolean") return fail(res, 400, "ACTIVE_INVALID", "active must be true or false");
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
    if (!doc) return fail(res, 404, "NOT_FOUND", "Location is not registered yet");

    const resolved = await resolvePin(req.body.pin, doc._id);
    if (resolved.error) return fail(res, resolved.status, resolved.code, resolved.error);

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
    if (resolved.error) return fail(res, resolved.status, resolved.code, resolved.error);

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
    res.json({ commands: rows.map(shapeCommand) });
}));

// Queue a command for a tent. Body: { locationId, command }
// Validated here (the public POST /command accepts any string)
router.post("/commands", wrap(async (req, res) => {
    const locationId = String(req.body.locationId || "").toLowerCase();
    const command = String(req.body.command || "");

    if (!SUPPORTED_COMMANDS.includes(command)) return fail(res, 400, "COMMAND_UNKNOWN", "Unsupported command");
    if (!registry.isValid(locationId)) return fail(res, 400, "LOCATION_INACTIVE", "That location is not Active");

    const doc = await Command.create({ locationId, command });
    res.status(201).json({ command: shapeCommand(doc) });
}));

// Cancel a command no Location has collected yet
router.post("/commands/:id/cancel", wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, "COMMAND_NOT_FOUND", "Command not Found");

    // Atomic: only an uncollected command can be cancelled, so this can never
    // overwrite a command the tent collected a moment earlier
    const updated = await Command.findOneAndUpdate(
        { _id: req.params.id, executed: false },
        { $set: { executed: true, cancelledAt: new Date() } },
        { new: true }
    );
    if (updated) return res.json({ command: shapeCommand(updated) });

    const existing = await Command.findById(req.params.id);
    if (!existing) return fail(res, 404, "COMMAND_NOT_FOUND", "Command not Found");
    if (existing.cancelledAt) return res.json({ command: shapeCommand(existing) }); // already cancelled: fine
    return fail(res, 409, "COMMAND_ALREADY_COLLECTED", "That Command was already Collected by the Tent");
}));

// ---------- Readings history (trend charts) ----------

// Query: locationId (required), hours (1-168, default 24), maxPoints (10-1000, default 288).
//
// Readings are grouped into equal TIME buckets and each bucket reports the
// average, minimum and maximum of every metric. Compared with "keep every Nth
// reading": averaging keeps a noisy sensor (pH!) readable, min/max keep brief
// spikes visible, and a missing bucket is an honest gap (the tent was not
// reporting) instead of a straight line drawn across it.
// Ages are seconds before NOW, measured on the server, so a wrong device clock
// cannot shift the chart.
router.get("/readings", wrap(async (req, res) => {
    const locationId = String(req.query.locationId || "").toLowerCase();
    if (!isSlug(locationId)) return fail(res, 400, "SLUG_INVALID", "locationId is required");

    const hours = clamp(parseInt(req.query.hours, 10) || 24, 1, 168);
    const maxPoints = clamp(parseInt(req.query.maxPoints, 10) || 288, 10, 1000);

    const nowMs = Date.now();
    const windowMs = hours * 3600 * 1000;
    const startMs = nowMs - windowMs;
    // At least 60 s (a tent pushes about every 30 s), widened so the window fits in maxPoints
    const bucketMs = Math.max(60000, Math.ceil(windowMs / maxPoints / 1000) * 1000);

    // Bucket number = how many bucket-widths after the window start this reading is
    const group = {
        _id: { $floor: { $divide: [{ $subtract: [{ $toLong: "$timestamp" }, startMs] }, bucketMs] } },
        count: { $sum: 1 }
    };
    for (const [key, field] of Object.entries(METRIC_FIELDS)) {
        group[`${key}Avg`] = { $avg: `$${field}` };
        group[`${key}Min`] = { $min: `$${field}` };
        group[`${key}Max`] = { $max: `$${field}` };
    }

    const rows = await Sensor.aggregate([
        { $match: { locationId, timestamp: { $gte: new Date(startMs), $lte: new Date(nowMs) } } },
        { $group: group },
        { $sort: { _id: 1 } } // oldest first
    ]);

    const points = rows.map((row) => {
        const bucketMiddleMs = startMs + (row._id + 0.5) * bucketMs;
        const point = {
            ageSeconds: Math.max(0, Math.round((nowMs - bucketMiddleMs) / 1000)),
            count: row.count
        };
        for (const key of Object.keys(METRIC_FIELDS)) {
            const avg = finiteOrNull(row[`${key}Avg`]);
            point[key] = {
                avg: avg === null ? null : Math.round(avg * 1000) / 1000,
                min: finiteOrNull(row[`${key}Min`]),
                max: finiteOrNull(row[`${key}Max`])
            };
        }
        return point;
    });

    res.json({
        locationId,
        hours,
        windowSeconds: hours * 3600,
        bucketSeconds: bucketMs / 1000,
        count: points.length,
        points
    });
}));

module.exports = router;