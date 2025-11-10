import express from "express";
import cors from "cors";
import admin from "firebase-admin";

// ===================================================================
// ✅ ENV + FIREBASE INITIALIZATION
// ===================================================================
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
  console.log("✅ Firebase credentials loaded");
} catch (error) {
  console.error("❌ Failed to parse SERVICE_ACCOUNT JSON:", error);
}

if (!serviceAccount) {
  console.error("❌ Missing Firebase credentials.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY || "TEST_KEY";

// ===================================================================
// ✅ TEST ROUTE
// ===================================================================
app.get("/", (req, res) => {
  res.send("✅ Seenzone Server Running");
});

// ===================================================================
// ✅ LOGIN ROUTE (NFC auto login with UID normalization)
// ===================================================================
app.post("/login", async (req, res) => {
  try {
    let { rfid_uid } = req.body;

    if (!rfid_uid) {
      return res.status(400).json({ message: "Missing RFID UID" });
    }

    // Normalize ALL UID formats to AA:BB:CC:DD
    rfid_uid = rfid_uid
      .replace(/[^a-fA-F0-9]/g, "")
      .toUpperCase()
      .match(/.{1,2}/g)
      .join(":");

    console.log("✅ Normalized UID:", rfid_uid);

    const snap = await db.collection("users")
      .where("rfid_uid", "==", rfid_uid)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    const userDoc = snap.docs[0];
    const data = userDoc.data();

    return res.status(200).json({
      userId: userDoc.id,
      name: data.name,
      balance: data.balance,
      rfid_uid: data.rfid_uid
    });

  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ===================================================================
// ✅ 1. GET USER DETAILS
// ===================================================================
app.get("/user/:rfid_uid", async (req, res) => {
  try {
    const { rfid_uid } = req.params;

    const snap = await db.collection("users")
      .where("rfid_uid", "==", rfid_uid)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json(snap.docs[0].data());
  } catch (err) {
    console.error("User Fetch Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ===================================================================
// ✅ 2. ADD PENDING ITEM
// ===================================================================
app.post("/addPending", async (req, res) => {
  try {
    const { rfid_uid, items, total } = req.body;

    if (!rfid_uid || !items || !total) {
      return res.status(400).json({ message: "Missing fields" });
    }

    await db.collection("pending_transactions").add({
      rfid_uid,
      items,
      total,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ message: "Pending added" });
  } catch (err) {
    console.error("Add Pending Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ===================================================================
// ✅ 3. CLEAR PENDING
// ===================================================================
app.delete("/clearPending/:rfid_uid", async (req, res) => {
  try {
    const { rfid_uid } = req.params;

    const snap = await db.collection("pending_transactions")
      .where("rfid_uid", "==", rfid_uid)
      .where("status", "==", "pending")
      .get();

    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    res.status(200).json({ message: "Pending cleared" });
  } catch (err) {
    console.error("Clear Pending Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ===================================================================
// ✅ 4. ANDROID RFID SCAN CONFIRMATION
// ===================================================================
app.post("/rfidScan", async (req, res) => {
  try {
    const { rfid_uid } = req.body;

    if (!rfid_uid) return res.status(400).json({ message: "Missing RFID UID" });

    await db.collection("pending_rfid")
      .doc("current")
      .set({
        rfid_uid,
        status: "scanned",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.status(200).json({ message: "RFID Recorded" });
  } catch (err) {
    console.error("RFID Scan Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ===================================================================
// ✅ 5. ESP8266 TRANSACTION PROCESSING
// ===================================================================
app.post("/transaction", async (req, res) => {
  try {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) return res.status(403).json({ message: "Invalid API key" });

    const { rfid_uid } = req.body;
    if (!rfid_uid) return res.status(400).json({ message: "Missing RFID UID" });

    console.log("✅ Received RFID UID:", rfid_uid);

    await db.collection("pending_rfid")
      .doc("current")
      .set({
        rfid_uid,
        status: "scanned",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    const userSnap = await db.collection("users")
      .where("rfid_uid", "==", rfid_uid)
      .limit(1)
      .get();

    if (userSnap.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    const userDoc = userSnap.docs[0];
    const userRef = userDoc.ref;

    const pendingSnap = await db.collection("pending_transactions")
      .where("rfid_uid", "==", rfid_uid)
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .get();

    if (pendingSnap.empty) {
      return res.status(404).json({ message: "No pending transactions" });
    }

    let totalAmount = 0;
    const allItems = [];

    pendingSnap.forEach(doc => {
      const data = doc.data();
      totalAmount += data.total || 0;

      data.items.forEach(item => {
        allItems.push({
          name: item.name,
          barcode: item.barcode,
          price: item.price,
          qty: item.qty || 1,
          subtotal: (item.price || 0) * (item.qty || 1)
        });
      });
    });

    await db.runTransaction(async (tx) => {
      const freshUser = await tx.get(userRef);
      const currentBalance = freshUser.get("balance") || 0;

      if (currentBalance < totalAmount) {
        throw new Error("Insufficient balance");
      }

      const newBalance = currentBalance - totalAmount;

      tx.update(userRef, { balance: newBalance });

      const transRef = db.collection("transactions").doc();
      tx.set(transRef, {
        userId: userRef.id,
        name: userDoc.data().name,
        rfid_uid,
        totalAmount,
        items: allItems,
        itemCount: allItems.length,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed"
      });

      pendingSnap.forEach(doc => {
        tx.update(doc.ref, {
          status: "completed",
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          transactionId: transRef.id
        });
      });
    });

    await db.collection("pending_rfid")
      .doc("current")
      .set({
        rfid_uid,
        status: "completed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    return res.status(200).json({ message: "Transaction Success" });

  } catch (err) {
    console.error("RFID Transaction Error:", err);

    if (err.message.includes("Insufficient balance")) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ===================================================================
// ✅ START SERVER
// ===================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
