const mongoose = require("mongoose");

/**
 * Access Control record for a Tent Location  - (or Master Code)

 * This collection Answers which PIN unlocks which Location
 
 * Two kinds of document:
 *  - role "location": one per tent, Holds that Tents own PIN Hash
 *  - role "master":   a single Document, no locationId. Its PIN unlocks every location that has a location Document
 */
const LocationSchema = new mongoose.Schema({
    role: {
        type: String,
        enum: ["location", "master"],
        default: "location",
        required: true
    },

    locationId: {
        type: String,
        trim: true,
        lowercase: true,
        unique: true,
        sparse: true,
        required: function () {
            return this.role === "location";
        }
    },

    displayName: { type: String, trim: true, maxlength: 60 },

    // false = deactivated: ingestion, commands and unlocking All Stop
    active: { type: Boolean, default: true },

    // "salt:hash" produced by utils/pin.js - The PIN is Never Stored
    pinHash: { type: String, required: true },

    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Location", LocationSchema);