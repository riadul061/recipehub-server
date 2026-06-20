const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
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

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
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