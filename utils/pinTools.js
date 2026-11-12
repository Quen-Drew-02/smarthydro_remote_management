const crypto = require("crypto");
const { verifyPin } = require("./pin");

// Cryptographically random 6-digit string. Always a STRING
function generatePin() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Rejects Trivially guessable PINs: 000000, 111111, 123456, 654321
function isWeakPin(pin) {
    if (/^(\d)\1{5}$/.test(pin)) return true;
    const d = [...pin].map(Number);
    const step = d[1] - d[0];
    return (step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step);
}

// Returns the document that already uses this PIN, or null. Hashes are
// salted, so the only way to check is to verify against each document
async function findPinOwner(pin, docs) {
    for (const doc of docs) {
        if (await verifyPin(pin, doc.pinHash)) return doc;
    }
    return null;
}

module.exports = { generatePin, isWeakPin, findPinOwner };