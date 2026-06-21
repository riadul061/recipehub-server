const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
dotenv.config();

const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL],
  }),
);
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
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
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

    app.get("/api/recipes/:id", async (req, res) => {
      try {
        const recipe = await recipesColl.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).json({ error: "Not found" });
        res.json({ recipe });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get("/api/recipes/my-recipes", verifyToken, async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const total = await recipesColl.countDocuments({ authorId: req.user.sub });
        const recipes = await recipesColl.find({ authorId: req.user.sub }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        res.json({ recipes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
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

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
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