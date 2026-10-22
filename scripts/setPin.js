/**
 * Admin script - Create or Rotate a location PIN or the master PIN

 * node scripts/setPin.js location <locationId> <6-digit-pin>
 * node scripts/setPin.js master <6-digit-pin>
 
 * Re-running for an existing location replaces its PIN. Refuses any PIN already used by
 * another location or the master

 * NOTE: the locationId should also be present in KNOWN_LOCATIONS in
 * server.js, otherwise that tents readings and commands are rejected
 * 
 * NOTE: a PIN typed on the command line stays in shell history; clear it if you want to keep it secret
 * The PIN is never stored in the database, only a Hash
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../db/connection");
const Location = require("../models/Location");
const { PIN_FORMAT, hashPin, verifyPin } = require("../utils/pin");

function usage() {
    console.error("Usage:\n  node scripts/setPin.js location <locationId> <pin>\n  node scripts/setPin.js master <pin>");
    process.exit(1);
}

async function main() {
    const [kind, ...rest] = process.argv.slice(2);

    let locationId = null;
    let pin;
    if (kind === "location" && rest.length === 2) {
        locationId = rest[0].trim().toLowerCase();
        pin = rest[1];
    } else if (kind === "master" && rest.length === 1) {
        pin = rest[0];
    } else {
        usage();
    }

    if (!PIN_FORMAT.test(pin)) {
        console.error("PIN must be Exactly 6 Digits");
        process.exit(1);
    }

    await connectDB();

    // Reject a PIN already used by any other Document
    const isSelf = (doc) =>
        kind === "master"
            ? doc.role === "master"
            : doc.role === "location" && doc.locationId === locationId;

    const all = await Location.find({});
    for (const doc of all.filter((d) => !isSelf(d))) {
        if (await verifyPin(pin, doc.pinHash)) {
            console.error("That PIN is Already in use by another Location or the Master. Choose a Different one.");
            await mongoose.disconnect();
            process.exit(1);
        }
    }

    const filter = kind === "master" ? { role: "master" } : { role: "location", locationId };
    await Location.updateOne(
        filter,
        { $set: { pinHash: await hashPin(pin), updatedAt: new Date() } },
        { upsert: true }
    );

    console.log(kind === "master" ? "Master PIN Set." : `PIN set for Location "${locationId}".`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});