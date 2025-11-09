import express from "express";
import cors from "cors";
import admin from "firebase-admin";

// ======== Firebase Initialization ========
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

// ======== ROUTES ========

// Health check
app.get("/", (req, res) => {
  res.send("✅ Server running with RFID + App endpoints");
});

// ===================================================================
// ✅ 1. APP LOGIN (name + rfid acts as password)
// ===================================================================
app.post("/login", async (req, res) => {
  try {
    const { name, rfid_uid } = req.body;

    if (!name || !rfid_uid) {
      return res.status(400).json({ message: "Missing name or RFID" });
    }

    const usersRef = db.collection("users");
    const snapshot = await usersRef
      .where("name", "==", name)
      .where("rfid_uid", "==", rfid_uid)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ message: "Invalid login" });
    }

    const user = snapshot.docs[0];
    const userData = user.data();

    return res.status(200).json({
      userId: user.id,
      name: userData.name,
      balance: userData.balance,
    });
  } catch (error) {
    console.error("❌ Login error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// ===================================================================
// ✅ 2. PRODUCT LOOKUP BY BARCODE
// ===================================================================
app.get("/product/:barcode", async (req, res) => {
  try {
    const barcode = req.params.barcode;

    const productsRef = db.collection("products");
    const snapshot = await productsRef.where("barcode", "==", barcode).get();

    if (snapshot.empty) {
      return res.status(404).json({ message: "Product not found" });
    }

    const product = snapshot.docs[0].data();

    return res.status(200).json(product);
  } catch (error) {
    console.error("❌ Product lookup error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// ===================================================================
// ✅ 3. NEW CHECKOUT ROUTE (Stores Pending Transactions)
// ===================================================================
app.post("/checkout", async (req, res) => {
  try {
    const { userId, cartItems, rfid_uid } = req.body;

    if (!userId || !cartItems || !rfid_uid) {
      return res.status(400).json({ message: "Missing userId, cartItems, or rfid_uid" });
    }

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ message: "cartItems must be a non-empty array" });
    }

    let total = 0;

    // Sum total price from the provided cart items
    cartItems.forEach(item => {
      total += (item.price || 0) * (item.qty || 1);
    });

    const pendingRef = db.collection("pending_transactions");

    await pendingRef.add({
      userId,
      rfid_uid,
      items: cartItems,
      total,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      message: "Checkout sent to pending. Please scan RFID to complete payment.",
      total
    });

  } catch (error) {
    console.error("❌ New Checkout Error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// ===================================================================
// ✅ 4. OPTIONAL DEBUG: View pending transactions
// ===================================================================
app.get("/pendingTest", async (req, res) => {
  try {
    const rfid = req.query.rfid;
    if (!rfid) return res.status(400).json({ message: "Missing rfid query" });

    const snaps = await db.collection("pending_transactions")
      .where("rfid_uid", "==", rfid)
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .get();

    const list = snaps.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({ pending: list });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "err", error: e.message });
  }
});

// ===================================================================
// ✅ 5. ESP8266 RFID PAYMENT PROCESSING (Atomic Transaction)
// ===================================================================
app.post("/transaction", async (req, res) => {
  try {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) return res.status(403).json({ message: "Invalid API key" });

    const { rfid_uid } = req.body;
    if (!rfid_uid) return res.status(400).json({ message: "Missing RFID UID" });

    console.log("Received RFID UID:", rfid_uid);

    // Find user
    const userSnap = await db.collection("users")
      .where("rfid_uid", "==", rfid_uid)
      .limit(1)
      .get();

    if (userSnap.empty) {
      return res.status(404).json({ message: "User not found" });
    }

    const userDoc = userSnap.docs[0];
    const userRef = userDoc.ref;

    // Load pending transactions
    const pendingSnap = await db.collection("pending_transactions")
      .where("rfid_uid", "==", rfid_uid)
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(10)
      .get();

    if (pendingSnap.empty) {
      return res.status(404).json({ message: "No pending transactions" });
    }

    // Sum totals
    let totalAmount = 0;
    const pendingDocs = [];

    for (const doc of pendingSnap.docs) {
      const data = doc.data();
      const docTotal = data.total || 0;

      totalAmount += docTotal;
      pendingDocs.push({ id: doc.id, ref: doc.ref, data, docTotal });
    }

    // Atomic Firestore Transaction
    await db.runTransaction(async (tx) => {
      const freshUser = await tx.get(userRef);
      const currentBalance = freshUser.get("balance") || 0;

      if (currentBalance < totalAmount) {
        throw new Error("Insufficient balance");
      }

      const newBalance = currentBalance - totalAmount;

      tx.update(userRef, { balance: newBalance });

      // Log single transaction
      const transRef = db.collection("transactions").doc();
      tx.set(transRef, {
        userId: userRef.id,
        rfid_uid,
        amount: totalAmount,
        items: pendingDocs.map(p => ({
          pendingDocId: p.id,
          items: p.data.items,
          total: p.docTotal
        })),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed"
      });

      // Mark pending as completed
      for (const p of pendingDocs) {
        tx.update(p.ref, {
          status: "completed",
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          transactionId: transRef.id
        });
      }
    });

    return res.status(200).json({ message: "Transaction Success" });

  } catch (err) {
    console.error("RFID Transaction Error:", err);
    if (err.message.includes("Insufficient balance")) {
      return res.status(400).json({ message: "Insufficient balance" });
    }
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ======== Start Server ========
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
