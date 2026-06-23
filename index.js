const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
const Stripe = require("stripe");
dotenv.config();

const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({ credentials: true, origin: [process.env.CLIENT_URL] }));
app.use("/api/webhooks", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));

const JWKS = createRemoteJWKSet(new URL(`${process.env.BETTER_AUTH_URL}/api/auth/jwks`));

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer")) return res.status(401).json({ msg: "Unauthorized" });
  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "Unauthorized" });
  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch { return res.status(401).json({ msg: "Unauthorized" }); }
};

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("recipehub");
    const recipesColl = db.collection("recipes");
    const favoritesColl = db.collection("favorites");
    const reportsColl = db.collection("reports");
    const paymentsColl = db.collection("payments");
    const userColl = db.collection("user");

    const verifyAdmin = async (req, res, next) => {
      if (req.user?.role !== "admin") return res.status(403).json({ msg: "Forbidden" });
      next();
    };

    // ===== RECIPES =====
    app.get("/api/recipes", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 12;
        const query = { status: { $ne: "removed" } };
        if (req.query.category) query.category = { $in: req.query.category.split(",").map(c => c.trim()) };
        if (req.query.search) query.recipeName = { $regex: req.query.search, $options: "i" };
        if (req.query.featured === "true") query.isFeatured = true;
        const total = await recipesColl.countDocuments(query);
        const recipes = await recipesColl.find(query).sort({ [req.query.sort || "createdAt"]: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        res.json({ recipes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get("/api/recipes/popular", async (req, res) => {
      try {
        const recipes = await recipesColl.find({ status: { $ne: "removed" } }).sort({ likesCount: -1 }).limit(6).toArray();
        res.json({ recipes });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ⚠️ my-recipes কে :id এর আগে রাখতে হবে
    app.get("/api/recipes/my-recipes", verifyToken, async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const total = await recipesColl.countDocuments({ authorId: req.user.sub });
        const recipes = await recipesColl.find({ authorId: req.user.sub }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        res.json({ recipes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get("/api/recipes/:id", async (req, res) => {
      try {
        const recipe = await recipesColl.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).json({ error: "Not found" });
        res.json({ recipe });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post("/api/recipes", verifyToken, async (req, res) => {
      try {
        if (!req.user.isPremium) {
          const count = await recipesColl.countDocuments({ authorId: req.user.sub });
          if (count >= 2) return res.status(403).json({ error: "Free limit: 2 recipes. Upgrade to premium!" });
        }
        const { recipeName, recipeImage, category, cuisineType, difficultyLevel, preparationTime, ingredients, instructions, price } = req.body;
        if (!recipeName || !recipeImage || !category || !cuisineType || !difficultyLevel || !preparationTime || !ingredients || !instructions)
          return res.status(400).json({ error: "Missing fields" });
        const doc = { recipeName, recipeImage, category, cuisineType, difficultyLevel, preparationTime, ingredients: Array.isArray(ingredients) ? ingredients : [ingredients], instructions, price: parseFloat(price) || 0, authorId: req.user.sub, authorName: req.user.name, authorEmail: req.user.email, likesCount: 0, likedBy: [], isFeatured: false, status: "active", purchasedBy: [], createdAt: new Date(), updatedAt: new Date() };
        const result = await recipesColl.insertOne(doc);
        res.status(201).json({ recipe: { ...doc, _id: result.insertedId } });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.put("/api/recipes/:id", verifyToken, async (req, res) => {
      try {
        const recipe = await recipesColl.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).json({ error: "Not found" });
        if (recipe.authorId !== req.user.sub && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
        delete req.body._id; delete req.body.authorId;
        await recipesColl.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { ...req.body, updatedAt: new Date() } });
        const updated = await recipesColl.findOne({ _id: new ObjectId(req.params.id) });
        res.json({ recipe: updated });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete("/api/recipes/:id", verifyToken, async (req, res) => {
      try {
        const recipe = await recipesColl.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).json({ error: "Not found" });
        if (recipe.authorId !== req.user.sub && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
        if (req.user.role === "admin") { await recipesColl.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "removed" } }); }
        else { await recipesColl.deleteOne({ _id: new ObjectId(req.params.id) }); await favoritesColl.deleteMany({ recipeId: req.params.id }); }
        res.json({ success: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post("/api/recipes/:id/like", verifyToken, async (req, res) => {
      try {
        const recipe = await recipesColl.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).json({ error: "Not found" });
        const liked = recipe.likedBy?.includes(req.user.sub);
        if (liked) { await recipesColl.updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { likedBy: req.user.sub }, $inc: { likesCount: -1 } }); }
        else { await recipesColl.updateOne({ _id: new ObjectId(req.params.id) }, { $addToSet: { likedBy: req.user.sub }, $inc: { likesCount: 1 } }); }
        const updated = await recipesColl.findOne({ _id: new ObjectId(req.params.id) });
        res.json({ likesCount: updated.likesCount, liked: !liked });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ===== FAVORITES =====
    app.get("/api/favorites", verifyToken, async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1, limit = parseInt(req.query.limit) || 10;
        const total = await favoritesColl.countDocuments({ userId: req.user.sub });
        const data = await favoritesColl.find({ userId: req.user.sub }).sort({ addedAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        const populated = await Promise.all(data.map(async f => { try { const r = await recipesColl.findOne({ _id: new ObjectId(f.recipeId) }); return { ...f, recipeId: r }; } catch { return { ...f, recipeId: null }; } }));
        res.json({ favorites: populated, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post("/api/favorites", verifyToken, async (req, res) => {
      try {
        const existing = await favoritesColl.findOne({ userId: req.user.sub, recipeId: req.body.recipeId });
        if (existing) return res.status(400).json({ error: "Already exists" });
        const r = await favoritesColl.insertOne({ userId: req.user.sub, userEmail: req.user.email, recipeId: req.body.recipeId, addedAt: new Date() });
        res.status(201).json({ favorite: { _id: r.insertedId } });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete("/api/favorites/:recipeId", verifyToken, async (req, res) => {
      try { await favoritesColl.deleteOne({ userId: req.user.sub, recipeId: req.params.recipeId }); res.json({ success: true }); }
      catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ===== REPORTS =====
    app.post("/api/reports", verifyToken, async (req, res) => {
      try {
        const r = await reportsColl.insertOne({ recipeId: req.body.recipeId, reporterEmail: req.user.email, reason: req.body.reason, status: "pending", createdAt: new Date() });
        res.status(201).json({ report: { _id: r.insertedId } });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ===== STRIPE =====
    app.post("/api/create-checkout-session", verifyToken, async (req, res) => {
      try {
        const { recipeId, type } = req.body;
        let lineItems, metadata = { userId: req.user.sub, userEmail: req.user.email, type: type || "recipe_purchase" };
        if (type === "premium") {
          lineItems = [{ price_data: { currency: "usd", product_data: { name: "RecipeHub Premium" }, unit_amount: 999 }, quantity: 1 }];
        } else if (recipeId) {
          const recipe = await recipesColl.findOne({ _id: new ObjectId(recipeId) });
          if (!recipe) return res.status(404).json({ error: "Not found" });
          const price = recipe.price > 0 ? recipe.price : 4.99;
          lineItems = [{ price_data: { currency: "usd", product_data: { name: recipe.recipeName }, unit_amount: Math.round(price * 100) }, quantity: 1 }];
          metadata.recipeId = recipeId;
        } else return res.status(400).json({ error: "Invalid" });
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"], line_items: lineItems, mode: "payment",
          success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/`, metadata,
        });
        res.json({ url: session.url });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post("/api/webhooks/stripe", async (req, res) => {
      try {
        const sig = req.headers["stripe-signature"];
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          const { userId, userEmail, type, recipeId } = session.metadata;
          await paymentsColl.insertOne({ userId, userEmail, amount: session.amount_total / 100, transactionId: session.id, paymentStatus: "completed", recipeId: recipeId || null, type: type || "recipe_purchase", paidAt: new Date() });
          if (type === "premium") { await userColl.updateOne({ _id: new ObjectId(userId) }, { $set: { isPremium: true } }); }
          else if (recipeId) { await recipesColl.updateOne({ _id: new ObjectId(recipeId) }, { $addToSet: { purchasedBy: userId } }); }
        }
        res.json({ received: true });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ===== USER =====
    app.get("/api/user/purchases", verifyToken, async (req, res) => {
      try {
        const data = await paymentsColl.find({ userId: req.user.sub, type: "recipe_purchase" }).sort({ paidAt: -1 }).toArray();
        const populated = await Promise.all(data.map(async p => { try { const r = p.recipeId ? await recipesColl.findOne({ _id: new ObjectId(p.recipeId) }) : null; return { ...p, recipeId: r }; } catch { return { ...p, recipeId: null }; } }));
        res.json({ purchases: populated });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get("/api/user/stats", verifyToken, async (req, res) => {
      try {
        const totalRecipes = await recipesColl.countDocuments({ authorId: req.user.sub });
        const totalFavorites = await favoritesColl.countDocuments({ userId: req.user.sub });
        const userRecipes = await recipesColl.find({ authorId: req.user.sub }).toArray();
        const totalLikes = userRecipes.reduce((s, r) => s + (r.likesCount || 0), 0);
        res.json({ totalRecipes, totalFavorites, totalLikes });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ===== ADMIN =====
    app.get("/api/admin/dashboard", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const [totalUsers, totalRecipes, premiumUsers, totalReports] = await Promise.all([
          userColl.countDocuments(), recipesColl.countDocuments(),
          userColl.countDocuments({ isPremium: true }),
          reportsColl.countDocuments({ status: "pending" }),
        ]);
        res.json({ totalUsers, totalRecipes, premiumUsers, totalReports });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
    //   try { const users = await userColl.find({}).toArray(); res.json({ users }); }
    //   catch (e) { res.status(500).json({ error: e.message }); }
    // });

    // app.put("/api/admin/users/:id/toggle-block", verifyToken, verifyAdmin, async (req, res) => {
    //   try { await userColl.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isBlocked: req.body.isBlocked } }); res.json({ success: true }); }
    //   catch (e) { res.status(500).json({ error: e.message }); }
    // });

    // app.get("/api/admin/recipes", verifyToken, verifyAdmin, async (req, res) => {
    //   try { const recipes = await recipesColl.find({}).sort({ createdAt: -1 }).toArray(); res.json({ recipes }); }
    //   catch (e) { res.status(500).json({ error: e.message }); }
    // });

    // app.patch("/api/admin/recipes/:id/feature", verifyToken, verifyAdmin, async (req, res) => {
    //   try { await recipesColl.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { isFeatured: req.body.isFeatured } }); res.json({ success: true }); }
    //   catch (e) { res.status(500).json({ error: e.message }); }
    // });

    // app.get("/api/admin/reports", verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const data = await reportsColl.find({}).sort({ createdAt: -1 }).toArray();
    //     const populated = await Promise.all(data.map(async r => { try { const recipe = await recipesColl.findOne({ _id: new ObjectId(r.recipeId) }); return { ...r, recipeId: recipe }; } catch { return { ...r, recipeId: null }; } }));
    //     res.json({ reports: populated });
    //   } catch (e) { res.status(500).json({ error: e.message }); }
    // });

    // app.patch("/api/admin/reports/:id", verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     if (req.body.action === "dismiss") { await reportsColl.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "dismissed" } }); }
    //     else if (req.body.action === "remove_recipe") {
    //       const report = await reportsColl.findOne({ _id: new ObjectId(req.params.id) });
    //       if (report) { await recipesColl.updateOne({ _id: new ObjectId(report.recipeId) }, { $set: { status: "removed" } }); await reportsColl.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "resolved" } }); }
    //     }
    //     res.json({ success: true });
    //   } catch (e) { res.status(500).json({ error: e.message }); }
    // });

    // app.get("/api/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const page = parseInt(req.query.page) || 1, limit = parseInt(req.query.limit) || 10;
    //     const total = await paymentsColl.countDocuments();
    //     const data = await paymentsColl.find({}).sort({ paidAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    //     res.json({ transactions: data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    //   } catch (e) { res.status(500).json({ error: e.message }); }
    // });

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("RecipeHub Server is running fine!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});