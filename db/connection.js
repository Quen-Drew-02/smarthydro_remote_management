require("dotenv").config();
const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI_HYDRO);

    // Log the Database Name only
    console.log(`🟢 MongoDB Connected (Database: ${mongoose.connection.name})`);
  } catch (error) {
    console.error("🔴 DB connection failed:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;