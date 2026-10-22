const crypto = require("crypto");
const { promisify } = require("util");


const scrypt = promisify(crypto.scrypt);

const KEY_LENGTH = 32;

// 6 Numeric Digits. PINs are Handled as STRINGS 
const PIN_FORMAT = /^\d{6}$/;


// Hashes a PIN with a Fresh random Salt using scrypt
async function hashPin(pin) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = await scrypt(pin, salt, KEY_LENGTH);
    return `${salt}:${derived.toString("hex")}`;
}

// Checks a PIN against a stored "salt:hash" string
async function verifyPin(pin, stored) {
    const [salt, hashHex] = stored.split(":");
    if (!salt || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const candidate = await scrypt(pin, salt, KEY_LENGTH);
    return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

module.exports = { PIN_FORMAT, hashPin, verifyPin };