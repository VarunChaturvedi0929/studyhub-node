/**
 * StudyHub — Node.js + Express + MySQL version.
 *
 * WHY Express-session (not JWT)?
 * Same reasoning as PHP/Flask versions: this is a server-rendered app
 * (EJS templates render full HTML pages), not a separate API + SPA.
 * express-session gives us the same "$_SESSION" / Flask "session" idea —
 * a signed cookie identifying the logged-in user.
 *
 * WHY mysql2 with parameterized queries (not an ORM)?
 * Kept close to raw SQL so it's easy to explain in an interview and
 * mirrors the exact same "prepared statements prevent SQL injection"
 * answer used in the PHP/Flask versions.
 */

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------
// Database pool (a pool, not a single connection, so multiple
// concurrent requests can each borrow a connection safely)
// ---------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "studyhub",
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// IMPORTANT: session middleware must be registered BEFORE any route that
// reads req.session (like the /uploads check below). Registering it after
// meant req.session was undefined whenever a PDF was requested -- that was
// the bug causing "Cannot read properties of undefined (reading 'userId')".
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change_this_to_a_random_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 day
  })
);

app.use("/uploads", (req, res, next) => {
  // Uploaded files require login, same as PHP's uploaded_file route
  if (!req.session.userId) return res.redirect("/login");
  next();
}, express.static(path.join(__dirname, "uploads")));

// Make session available in all EJS templates without passing it manually every time
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// ---------------------------------------------------------------
// Auth middleware (equivalent to requireLogin()/requireAdmin())
// ---------------------------------------------------------------
function loginRequired(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  next();
}

function adminRequired(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  if (req.session.role !== "admin") return res.redirect("/dashboard");
  next();
}

// ---------------------------------------------------------------
// File upload config (multer)
// ---------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "uploads")),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^A-Za-z0-9_.-]/g, "_");
    cb(null, `${Date.now()}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

// ---------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------
app.get("/", (req, res) => res.render("index"));

app.get("/register", (req, res) => res.render("register", { error: null }));

app.post("/register", async (req, res) => {
  const { name, email, password, department, semester } = req.body;

  if (!name || !email || !password) {
    return res.render("register", { error: "All fields are required." });
  }

  const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.length > 0) {
    return res.render("register", { error: "Email already registered." });
  }

  // bcrypt salts + hashes the password -- same role as PHP's password_hash()
  const hashed = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO users (name, email, password, department, semester) VALUES (?,?,?,?,?)",
    [name, email, hashed, department, semester]
  );

  res.redirect("/login?registered=1");
});

app.get("/login", (req, res) =>
  res.render("login", { error: null, registered: req.query.registered })
);

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const [rows] = await pool.query(
    "SELECT id, name, password, role FROM users WHERE email = ?",
    [email]
  );

  if (rows.length === 0) {
    return res.render("login", { error: "No account found with that email.", registered: null });
  }

  const user = rows[0];
  const match = await bcrypt.compare(password, user.password);

  if (!match) {
    return res.render("login", { error: "Incorrect password.", registered: null });
  }

  req.session.userId = user.id;
  req.session.name = user.name;
  req.session.role = user.role;
  res.redirect("/dashboard");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------
app.get("/dashboard", loginRequired, async (req, res) => {
  const userId = req.session.userId;

  const [[user]] = await pool.query(
    "SELECT department, semester FROM users WHERE id = ?",
    [userId]
  );

  const [[{ total: resourceCount }]] = await pool.query(
    "SELECT COUNT(*) as total FROM resources WHERE department = ? AND status = 'approved'",
    [user.department]
  );

  const [[progress]] = await pool.query(
    "SELECT COUNT(*) as total, SUM(is_completed) as done FROM study_progress WHERE user_id = ?",
    [userId]
  );
  const total = progress.total || 0;
  const done = progress.done || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const [streakDays] = await pool.query(
    "SELECT study_date FROM study_streak WHERE user_id = ? ORDER BY study_date DESC LIMIT 14",
    [userId]
  );

  res.render("dashboard", { user, resourceCount, percent, streakCount: streakDays.length });
});

// ---------------------------------------------------------------
// Resources — browse & filter
// ---------------------------------------------------------------
app.get("/resources", loginRequired, async (req, res) => {
  const { department = "", type = "", semester = "", search = "" } = req.query;

  let sql = `SELECT r.*, u.name as uploader FROM resources r
             JOIN users u ON r.uploaded_by = u.id
             WHERE r.status = 'approved'`;
  const params = [];

  if (department) { sql += " AND r.department = ?"; params.push(department); }
  if (type) { sql += " AND r.type = ?"; params.push(type); }
  if (semester) { sql += " AND r.semester = ?"; params.push(semester); }
  if (search) {
    sql += " AND (r.title LIKE ? OR r.subject LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += " ORDER BY r.created_at DESC";

  const [resources] = await pool.query(sql, params);

  res.render("resources", { resources, department, type, semester, search });
});

// ---------------------------------------------------------------
// Upload
// ---------------------------------------------------------------
app.get("/upload", loginRequired, (req, res) =>
  res.render("upload", { error: null, success: null })
);

app.post("/upload", loginRequired, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      return res.render("upload", { error: err.message, success: null });
    }
    if (!req.file) {
      return res.render("upload", { error: "Please select a valid file.", success: null });
    }

    const { title, type, department, subject, semester, year } = req.body;

    await pool.query(
      `INSERT INTO resources (title, type, department, subject, semester, year, file_path, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [title, type, department, subject, semester, year, req.file.filename, req.session.userId]
    );

    res.render("upload", {
      error: null,
      success: "Uploaded! It will be visible once an admin approves it.",
    });
  });
});

// ---------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------
app.get("/admin", adminRequired, async (req, res) => {
  const [pending] = await pool.query(
    `SELECT r.*, u.name as uploader FROM resources r
     JOIN users u ON r.uploaded_by = u.id
     WHERE r.status = 'pending' ORDER BY r.created_at ASC`
  );
  res.render("admin", { pending });
});

app.get("/admin/action", adminRequired, async (req, res) => {
  const { action, id } = req.query;

  if (action === "approve") {
    await pool.query("UPDATE resources SET status = 'approved' WHERE id = ?", [id]);
  } else if (action === "reject") {
    const [[row]] = await pool.query("SELECT file_path FROM resources WHERE id = ?", [id]);
    if (row) {
      const filePath = path.join(__dirname, "uploads", row.file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await pool.query("DELETE FROM resources WHERE id = ?", [id]);
  }

  res.redirect("/admin");
});

// ---------------------------------------------------------------
// Study tracker
// ---------------------------------------------------------------
app.get("/progress", loginRequired, async (req, res) => {
  const userId = req.session.userId;

  const [rows] = await pool.query(
    "SELECT * FROM study_progress WHERE user_id = ? ORDER BY subject, id",
    [userId]
  );

  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.subject]) grouped[r.subject] = [];
    grouped[r.subject].push(r);
  }

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13);

  const [activeRows] = await pool.query(
    "SELECT study_date FROM study_streak WHERE user_id = ? AND study_date >= ?",
    [userId, fourteenDaysAgo.toISOString().slice(0, 10)]
  );
  const activeDates = new Set(activeRows.map((r) => r.study_date.toISOString().slice(0, 10)));

  const streakGrid = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    streakGrid.push({ date: iso, active: activeDates.has(iso) });
  }

  res.render("progress", { grouped, streakGrid });
});

app.post("/progress", loginRequired, async (req, res) => {
  const { subject, topic } = req.body;
  if (subject && topic) {
    await pool.query(
      "INSERT INTO study_progress (user_id, subject, topic) VALUES (?,?,?)",
      [req.session.userId, subject, topic]
    );
  }
  res.redirect("/progress");
});

app.post("/toggle_topic", loginRequired, async (req, res) => {
  const { id } = req.body;
  const userId = req.session.userId;

  // Ownership check -- same defense as PHP/Flask versions: prevents
  // toggling someone else's topic by guessing IDs
  const [[row]] = await pool.query(
    "SELECT is_completed FROM study_progress WHERE id = ? AND user_id = ?",
    [id, userId]
  );

  if (!row) {
    return res.status(404).json({ success: false, message: "Topic not found" });
  }

  const newStatus = row.is_completed ? 0 : 1;
  await pool.query("UPDATE study_progress SET is_completed = ? WHERE id = ?", [newStatus, id]);

  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO study_streak (user_id, study_date, minutes_studied) VALUES (?,?,5)
     ON DUPLICATE KEY UPDATE minutes_studied = minutes_studied + 5`,
    [userId, today]
  );

  res.json({ success: true, is_completed: !!newStatus });
});

app.listen(PORT, () => console.log(`StudyHub running on http://localhost:${PORT}`));