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
 *
 * WHY the `ah()` wrapper around every async route?
 * Express 4 does NOT automatically catch errors thrown inside an async
 * route handler. If an `await`ed call rejects (a bad query, a dropped DB
 * connection, a destructure of an empty result) and nothing catches it,
 * Node treats it as an unhandled promise rejection -- and modern Node
 * versions (v15+) TERMINATE THE ENTIRE PROCESS when that happens. On
 * Render this looked like a mysterious crash-loop ("Exited with status
 * 1", server restarts, works for a bit, crashes again). Wrapping every
 * async handler in `ah()` forwards any error to Express's error-handling
 * middleware instead of letting it escape and kill the whole server.
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

// Wrap an async route handler so rejected promises go to next(err)
// instead of crashing the process.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------
// Database pool (a pool, not a single connection, so multiple
// concurrent requests can each borrow a connection safely)
// ---------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "studyhub",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change_this_to_a_random_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 day
  })
);

app.use("/uploads", (req, res, next) => {
  if (!req.session.userId) return res.redirect("/login");
  next();
}, express.static(path.join(__dirname, "uploads")));

app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// ---------------------------------------------------------------
// Auth middleware
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
  limits: { fileSize: 10 * 1024 * 1024 },
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

app.post("/register", ah(async (req, res) => {
  const { name, email, password, department, semester } = req.body;

  if (!name || !email || !password) {
    return res.render("register", { error: "All fields are required." });
  }

  const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.length > 0) {
    return res.render("register", { error: "Email already registered." });
  }

  const hashed = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO users (name, email, password, department, semester) VALUES (?,?,?,?,?)",
    [name, email, hashed, department, semester]
  );

  res.redirect("/login?registered=1");
}));

app.get("/login", (req, res) =>
  res.render("login", { error: null, registered: req.query.registered })
);

app.post("/login", ah(async (req, res) => {
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
}));

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------
app.get("/dashboard", loginRequired, ah(async (req, res) => {
  const userId = req.session.userId;

  const [userRows] = await pool.query(
    "SELECT department, semester FROM users WHERE id = ?",
    [userId]
  );

  // If the session points to a user_id that no longer exists in the DB
  // (e.g. the row was deleted/recreated directly in the database), don't
  // crash trying to destructure an empty result -- just log them out
  // cleanly and send them back to login instead.
  if (userRows.length === 0) {
    return req.session.destroy(() => res.redirect("/login"));
  }
  const user = userRows[0];

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
}));

// ---------------------------------------------------------------
// Resources — browse & filter
// ---------------------------------------------------------------
app.get("/resources", loginRequired, ah(async (req, res) => {
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
}));

// ---------------------------------------------------------------
// Upload
// ---------------------------------------------------------------
app.get("/upload", loginRequired, (req, res) =>
  res.render("upload", { error: null, success: null })
);

app.post("/upload", loginRequired, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.render("upload", { error: err.message, success: null });
    }
    if (!req.file) {
      return res.render("upload", { error: "Please select a valid file.", success: null });
    }

    const { title, type, department, subject, semester, year } = req.body;

    pool.query(
      `INSERT INTO resources (title, type, department, subject, semester, year, file_path, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [title, type, department, subject, semester, year, req.file.filename, req.session.userId]
    )
      .then(() => {
        res.render("upload", {
          error: null,
          success: "Uploaded! It will be visible once an admin approves it.",
        });
      })
      .catch(next);
  });
});

// ---------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------
app.get("/admin", adminRequired, ah(async (req, res) => {
  const [pending] = await pool.query(
    `SELECT r.*, u.name as uploader FROM resources r
     JOIN users u ON r.uploaded_by = u.id
     WHERE r.status = 'pending' ORDER BY r.created_at ASC`
  );
  res.render("admin", { pending });
}));

app.get("/admin/action", adminRequired, ah(async (req, res) => {
  const { action, id } = req.query;

  if (action === "approve") {
    await pool.query("UPDATE resources SET status = 'approved' WHERE id = ?", [id]);
  } else if (action === "reject") {
    const [rows] = await pool.query("SELECT file_path FROM resources WHERE id = ?", [id]);
    if (rows.length > 0) {
      const filePath = path.join(__dirname, "uploads", rows[0].file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await pool.query("DELETE FROM resources WHERE id = ?", [id]);
  }

  res.redirect("/admin");
}));

// ---------------------------------------------------------------
// Study tracker
// ---------------------------------------------------------------
app.get("/progress", loginRequired, ah(async (req, res) => {
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
}));

app.post("/progress", loginRequired, ah(async (req, res) => {
  const { subject, topic } = req.body;
  if (subject && topic) {
    await pool.query(
      "INSERT INTO study_progress (user_id, subject, topic) VALUES (?,?,?)",
      [req.session.userId, subject, topic]
    );
  }
  res.redirect("/progress");
}));

app.post("/toggle_topic", loginRequired, ah(async (req, res) => {
  const { id } = req.body;
  const userId = req.session.userId;

  const [rows] = await pool.query(
    "SELECT is_completed FROM study_progress WHERE id = ? AND user_id = ?",
    [id, userId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: "Topic not found" });
  }
  const row = rows[0];

  const newStatus = row.is_completed ? 0 : 1;
  await pool.query("UPDATE study_progress SET is_completed = ? WHERE id = ?", [newStatus, id]);

  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO study_streak (user_id, study_date, minutes_studied) VALUES (?,?,5)
     ON DUPLICATE KEY UPDATE minutes_studied = minutes_studied + 5`,
    [userId, today]
  );

  res.json({ success: true, is_completed: !!newStatus });
}));

// ---------------------------------------------------------------
// Global error handler — catches anything forwarded by ah() or next(err).
// This is what keeps one bad request from taking down the whole server.
// Must be defined LAST, after all routes, and must have 4 arguments for
// Express to recognize it as an error-handling middleware.
// ---------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("Unhandled error on", req.method, req.path, ":", err);
  if (res.headersSent) return next(err);
  res.status(500).send(
    "Something went wrong on our end. Please try again in a moment."
  );
});

// Extra safety net: log and survive instead of crashing the whole process
// on any error that somehow still slips through uncaught.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

app.listen(PORT, () => console.log(`StudyHub running on http://localhost:${PORT}`));