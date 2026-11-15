const mongoose = require("mongoose");

const CommandSchema = new mongoose.Schema({

  // Which tent this command is intended for. Required for the same
  // reason as Sensor.locationId. Set by whoever queues
  // the command via POST /command - the mobile app, or a manual curl call.
  //
  // Before this change:
  // GET /command handed out the oldest unexecuted command to whichever
  // tent's ESP32 happened to poll next, with no concept of which tent it
  // was meant for. With three tents polling the same endpoint, a command
  // meant for one tent could easily be claimed and executed by another.
  locationId: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },

  command: String,

  executed: {              // 👈 ADD THIS
    type: Boolean,
    default: false
  },

  // Set when an ESP32 collects the command, shows how long a command waited before it was picked up
  executedAt: { type: Date },

  // Set when an admin cancels a command before any tent collected it. A
  // cancelled command is also marked executed:true so the tent's poll
  // (which only returns executed:false) never delivers it, without
  // changing that live route.
  cancelledAt: { type: Date },

  createdAt: { type: Date, default: Date.now }
});

// Matches the exact query in GET /command: "oldest unexecuted command for
// this specific location". Without this compound index, that query scans
// across every tent's commands mixed together instead of using the index.
CommandSchema.index({ locationId: 1, executed: 1, createdAt: 1 });

module.exports = mongoose.model("Command", CommandSchema);