import express from "express";
import cors from "cors";
import admin from "firebase-admin";

// ======== Firebase Initialization ========
// Render passes secrets as environment variables
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
} catch (error) {
  console.error("❌ Failed to parse SERVICE_ACCOUNT JSON:", error);
}

if (!serviceAccount) {
  console.error("❌ Missing Firebase credentials. Check Render Environment Variables.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ======== Express App Setup ========
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || "ESP_SHARED_KEY_123";

// ======== Routes ========

// Health check route
app.get("/", (req, res) => {
  res.send("✅ RFID Server is running and connected to Firebase");
});

// RFID Transaction route
app.post("/transaction", async (req, res) => {
  try {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) {
      return res.status(403).json({ message: "Invalid API key" });
    }

    const { rfid_uid } = req.body;
    if (!rfid_uid) {
      return res.status(400).json({ message: "Missing RFID UID" });
    }

    console.log("📡 Received RFID UID:", rfid_uid);

    // Search for user in Firestore
    const usersRef = db.collection("users");
    const snapshot = await usersRef.where("rfid_uid", "==", rfid_uid).get();

    if (snapshot.empty) {
      console.log("⚠️ No user found for RFID:", rfid_uid);
      return res.status(404).json({ message: "User not found" });
    }

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();

    // Log transaction
    await db.collection("transactions").add({
      userId: userDoc.id,
      name: userData.name,
      rfid_uid,
      createdAt: new Date(),
    });

    console.log("✅ Transaction recorded for:", userData.name);
    return res.status(200).json({ message: "Transaction Success" });
  } catch (error) {
    console.error("❌ Error processing RFID:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
});

// ======== Start Server ========
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
