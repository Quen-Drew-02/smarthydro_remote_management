const express = require("express");
const cors = require("cors");

const connectDB = require("./db/connection");
const Sensor = require("./models/Sensor");
const Command = require("./models/Command");
const Photo = require("./models/Photo");
 
const Location = require("./models/Location");
const { PIN_FORMAT, verifyPin } = require("./utils/pin");

const app = express();
app.use(express.json());
app.use(cors());

// 🔌 connect database
connectDB();

// Known Deployed Tents. This is intentionally a soft guard, not a hard
// schema constraint - GET /locations always reflects whatever locationIds
// actually exist in the Sensor collection, so a new tent still shows up in
// the app automatically once it posts its first reading. This list exists
// purely to reject obvious typos at write time (e.g. "durban_noth") before
// they create a silent phantom "location" in the data. Add a new slug here
// when a new tent is deployed, matching its ESP32's LOCATION_ID exactly.
const KNOWN_LOCATIONS = ["durban_north", "namibia", "sweet_waters", "qachas_nek_1", "sweetwaters_tunnel"];

function isValidLocationId(locationId) {
  return typeof locationId === "string" && KNOWN_LOCATIONS.includes(locationId.toLowerCase());
}

// ===== ROUTES =====

// 📥 Receive sensor data
// Body must now include locationId (see Sensor.js). Readings without one,
// or with an unrecognised one, are rejected rather than silently stored -
// this is deliberately stricter than before, since a mis-tagged reading is
// worse than a dropped one (it would misattribute data to the wrong tent).
app.post("/data", async (req, res) => {
  try {
    console.log("Incoming data:", req.body);

    const { locationId } = req.body;
    if (!isValidLocationId(locationId)) {
      return res.status(400).json({
        error: "locationId is Required and Must be one of: " + KNOWN_LOCATIONS.join(", ")
      });
    }

    const data = new Sensor(req.body);
    await data.save();

    res.json({ status: "saved" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📤 Get latest command for a specific tent
// locationId is now a REQUIRED query param, not optional - this is the
// fix for the cross-tent command bug. A poll
// without a locationId is rejected rather than falling back to the old
// "any tent's oldest command" behavior
app.get("/command", async (req, res) => {
  const { locationId } = req.query;
  if (!isValidLocationId(locationId)) {
    return res.status(400).json({
      error: "locationId query param is Required and must be one of: " + KNOWN_LOCATIONS.join(", ")
    });
  }

  const cmd = await Command.findOne({
    locationId: locationId.toLowerCase(),
    executed: false
  }).sort({ createdAt: -1 });

  if (cmd) {
    cmd.executed = true;
    await cmd.save();
    return res.send(cmd.command);
  }

  res.send("none");
});

// 🎮 Send command to a specific tent
// Body must now include both command and locationId - the caller (mobile
// app, or a manual curl) must say which tent this is for.
app.post("/command", async (req, res) => {
  const { command, locationId } = req.body;

  if (!isValidLocationId(locationId)) {
    return res.status(400).json({
      error: "locationId is Required and Must be one of: " + KNOWN_LOCATIONS.join(", ")
    });
  }

  console.log("New command:", command, "for", locationId);

  const cmd = new Command({ command, locationId: locationId.toLowerCase() });
  await cmd.save();

  res.json({ status: "command stored" });
});

// 📊 View recent data, optionally scoped to one tent
// locationId is OPTIONAL here (unlike /command above) - omitting it
// preserves the original "last 10 readings" behavior, just now potentially
// spanning multiple tents if unfiltered. The mobile app should always pass
// locationId once a location is selected; this stays optional mainly so
// existing manual/debugging calls to this endpoint don't break.
app.get("/data", async (req, res) => {
  const { locationId } = req.query;

  const filter = {};
  if (locationId) {
    if (!isValidLocationId(locationId)) {
      return res.status(400).json({
        error: "locationId must be one of: " + KNOWN_LOCATIONS.join(", ")
      });
    }
    filter.locationId = locationId.toLowerCase();
  }

  const data = await Sensor.find(filter).sort({ timestamp: -1 }).limit(10);
  res.json(data);
});

// 📍 List distinct locations currently reporting data
// Drives the location selector in the mobile app. Deliberately reads from
// the actual data (distinct locationIds already in the Sensor collection)
// rather than returning the hardcoded KNOWN_LOCATIONS list above - a newly
// deployed tent shows up here automatically the moment it posts its first
// reading, with no backend redeploy needed.
app.get("/locations", async (req, res) => {
  try {
    const locations = await Sensor.distinct("locationId");
    res.json({ locations: locations.filter(Boolean) });  // Filter out falsy values (null, empty strings) from legacy or unvalidated data
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unlock location(s) with a PIN
//
// The app sends a 6-digit PIN, the backend finds which document it belongs
// to. A location PIN unlocks that one location; the master PIN unlocks
// every location that has a Location document. The app stores the returned
// ids on the Device and only shows those Locations to the User
app.post("/locations/unlock", async (req, res) => {
  const { pin } = req.body;

  if (typeof pin !== "string" || !PIN_FORMAT.test(pin)) {
    return res.status(400).json({ error: "PIN must be exactly 6 Digits" });
  }

  const docs = await Location.find({});

  let matched = null;
  for (const doc of docs) {
    if (await verifyPin(pin, doc.pinHash)) {
      matched = doc;
      break;
    }
  }

  // Same response for "Wrong PIN" and "no PINs Configured"
  if (!matched) {
    return res.status(401).json({ error: "Invalid PIN" });
  }

  if (matched.role === "master") {
    const unlocked = docs.filter((d) => d.role === "location").map((d) => d.locationId);
    return res.json({ unlocked, master: true });
  }

  res.json({ unlocked: [matched.locationId], master: false });
});

//App calls this to request a fresh photo from the tent's camera
app.post("/photo/request", async (req, res) => {
  const { locationId } = req.body;
  if (!isValidLocationId(locationId)) {
    return res.status(400).json({
      error: "locationId is Required and Must be one of: " + KNOWN_LOCATIONS.join(", ")
    });
  }
 
  await Photo.findOneAndUpdate(
    { locationId: locationId.toLowerCase() },
    { pending: true },
    { upsert: true }
  );
 
  res.json({ status: "requested" });
});
 
//Camera polls this to check whether a photo has been requested
app.get("/photo/pending", async (req, res) => {
  const { locationId } = req.query;
  if (!isValidLocationId(locationId)) {
    return res.status(400).json({
      error: "locationId query param is Required and must be one of: " + KNOWN_LOCATIONS.join(", ")
    });
  }
 
  const photo = await Photo.findOne({ locationId: locationId.toLowerCase() });
  res.json({ pending: photo ? photo.pending === true : false });
});
 
//Camera uploads the captured JPEG here (raw bytes)
app.post("/photo", express.raw({ type: "image/jpeg", limit: "5mb" }), async (req, res) => {
  const { locationId } = req.query;
  if (!isValidLocationId(locationId)) {
    return res.status(400).json({
      error: "locationId query param is Required and must be one of: " + KNOWN_LOCATIONS.join(", ")
    });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: "empty request body - expected raw JPEG bytes" });
  }
 
  const capturedAt = new Date();
  await Photo.findOneAndUpdate(
    { locationId: locationId.toLowerCase() },
    { data: req.body, contentType: "image/jpeg", pending: false, capturedAt },
    { upsert: true }
  );
 
  res.json({ status: "ok", capturedAt: capturedAt.toISOString() });
});
 
//App calls this to check for/fetch the latest photo's metadata
app.get("/photo", async (req, res) => {
  const { locationId } = req.query;
  if (!isValidLocationId(locationId)) {
    return res.status(400).json({
      error: "locationId query param is Required and must be one of: " + KNOWN_LOCATIONS.join(", ")
    });
  }
 
  const photo = await Photo.findOne({ locationId: locationId.toLowerCase() });
  if (!photo || !photo.capturedAt) {
    return res.json({ url: null, capturedAt: null });
  }
 
  // The &v= parameter acts as a cache-buster. Because the base /photo/file URL remains constant, this ensures Coil loads the latest image rather than a cached copy.
  res.json({
    url: `https://${req.get("host")}/photo/file?locationId=${locationId.toLowerCase()}&v=${photo.capturedAt.getTime()}`,
    capturedAt: photo.capturedAt
  });
});
 
//Serves the actual JPEG bytes - the URL GET /photo hands back
app.get("/photo/file", async (req, res) => {
  const { locationId } = req.query;
  if (!isValidLocationId(locationId)) {
    return res.status(400).send("invalid locationId");
  }
 
  const photo = await Photo.findOne({ locationId: locationId.toLowerCase() });
  if (!photo || !photo.data) {
    return res.status(404).send("no photo yet");
  }
 
  res.set("Content-Type", photo.contentType || "image/jpeg");
  res.send(photo.data);
});
 

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});