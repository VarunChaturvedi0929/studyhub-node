# StudyHub (Node.js version) — Interview Prep Guide

Read the comparison table in README.md first. This doc covers Node/Express-specific questions.

---

## 1. Project Pitch

> "StudyHub is a department-wise academic resource platform with a personal study tracker, built with Node.js, Express, and MySQL, using EJS for server-side templating and session-based authentication. I designed the same schema and feature set across a couple of backend implementations to understand how the same application logic maps across different stacks."

*(Only say the multi-stack part if genuinely asked "why Node" — don't volunteer that you built three versions unless it comes up naturally; focus the pitch on the one you're presenting.)*

---

## 2. Node.js / Express Fundamentals

**Q: What is Node.js?**
- A JavaScript runtime that lets you run JS outside the browser (on a server). Built on Chrome's V8 engine.

**Q: What is Express?**
- A minimal web framework for Node.js — handles routing, middleware, and request/response objects, similar to how Flask is a micro-framework for Python.

**Q: What's the single most important difference between Node.js and PHP/Flask, architecturally?**
- **Node.js is single-threaded and non-blocking (asynchronous)**. PHP and Flask (in their basic setup) are synchronous/blocking — each request typically waits for a database query to finish before moving on. Node.js instead uses an event loop: while waiting for a slow operation (like a MySQL query), Node can serve other incoming requests instead of sitting idle. This is why nearly everything in `server.js` uses `async/await`.

**Q: What is `async/await`?**
- Syntax for working with Promises (JavaScript's way of handling asynchronous operations) that looks synchronous but isn't. `await pool.query(...)` pauses that specific request's execution until the query resolves, without blocking the entire server from handling other users' requests simultaneously.

**Q: What is middleware in Express?**
- A function that runs between the incoming request and the final route handler. Example: `app.use(session(...))` runs on every request to attach session data before any route logic executes. `loginRequired` is custom middleware that checks auth before letting a request reach a protected route.

**Q: Walk me through what happens when someone visits `/dashboard`.**
1. Request hits Express's routing.
2. The `session` middleware reads the signed cookie and populates `req.session`.
3. `loginRequired` middleware checks `req.session.userId` — redirects to `/login` if missing.
4. If passed, the `/dashboard` handler runs: queries MySQL (`await pool.query(...)`) for user info, resource count, progress.
5. `res.render("dashboard", {...})` renders the EJS template with that data and sends HTML back.

---

## 3. Database Questions

**Q: What is a connection pool, and why use one instead of a single connection?**
- `mysql.createPool()` maintains a set of reusable database connections (10 in this project) instead of one single connection. Since Node.js can handle many requests concurrently (thanks to async/await), multiple requests might need the database at the same time — a pool lets each borrow a free connection instead of queueing behind a single one.

**Q: How did you prevent SQL injection?**
- Every query uses `?` placeholders with parameters passed separately: `pool.query("SELECT * FROM users WHERE email = ?", [email])`. Same protection mechanism as PHP's `bind_param()` and Flask's `%s` placeholders — the driver treats parameters strictly as data, never executable SQL.

---

## 4. Security Questions

**Q: How are passwords stored?**
- `bcrypt.hash(password, 10)` — the `10` is the "salt rounds" / cost factor, controlling how computationally expensive the hash is (higher = slower to brute-force, but slower to compute at login too). Verified at login with `bcrypt.compare()`.

**Q: How is XSS prevented?**
- EJS's `<%= value %>` syntax **auto-escapes** HTML by default (similar to Jinja2 in the Flask version). Only `<%- value %>` (used for `_header`/`_footer` includes, not user data) renders raw, unescaped HTML — so as long as user-supplied data always uses `<%= %>`, it's safe.

**Q: How did you validate file uploads?**
- `multer`'s `fileFilter` option checks `file.mimetype === "application/pdf"` before accepting the upload, and `limits: { fileSize: 10MB }` rejects oversized files. Filenames are sanitized (`replace(/[^A-Za-z0-9_.-]/g, "_")`) before saving to disk to avoid path traversal or unexpected characters.

**Q: Why are uploaded files served through a custom route with a login check, instead of Express's plain static middleware?**
```js
app.use("/uploads", (req, res, next) => {
  if (!req.session.userId) return res.redirect("/login");
  next();
}, express.static(...));
```
- Plain `express.static("uploads")` would let anyone download files just by guessing the URL, even without logging in. Adding the login check in front of it keeps resources gated to authenticated users, similar to how the PHP version's `uploaded_file` route required `login_required`.

---

## 5. AJAX Flow (same as PHP/Flask, JSON in both directions)

**Q: Walk me through the study tracker checkbox toggle.**
1. `fetch('/toggle_topic', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id: topicId})})`
2. Express's `express.json()` middleware parses the JSON body into `req.body`
3. Route checks the topic belongs to the logged-in user (`WHERE id=? AND user_id=?`)
4. Flips `is_completed`, logs today in `study_streak` with `ON DUPLICATE KEY UPDATE`
5. Responds with `res.json({success: true, is_completed: ...})`
6. JS updates checkbox styling based on the response — no full page reload

---

## 6. Setup / Deployment Questions

**Q: How do you run this locally?**
```bash
npm install
npm start
```
Then visit `http://localhost:3000/`.

**Q: What's `package.json` for?**
- Declares the project's dependencies (Express, mysql2, bcrypt, etc.) and scripts (`npm start` runs `node server.js`). `npm install` reads it and downloads everything listed into `node_modules/`.

**Q: Why is there a `.env` file and a `.env.example`?**
- `.env` holds real secrets (DB password, session secret) and is excluded from Git via `.gitignore` — you never want credentials in a public repo. `.env.example` is a template showing what variables are needed, without real values, so anyone cloning the repo knows what to set up.

**Q: How would you deploy this to production?**
- Node.js apps deploy well on platforms built for them — Render, Railway, or a VPS with a process manager like PM2 (which restarts the app if it crashes and can run multiple instances). Unlike PHP, there's no Apache/XAMPP-style requirement — Node runs its own HTTP server directly (`app.listen(PORT)`), so hosting is often simpler for Node apps specifically.

---

## Quick Reference

| File | Purpose |
|---|---|
| `server.js` | All routes, DB queries, auth, middleware |
| `views/_header.ejs` / `_footer.ejs` | Shared layout pieces |
| `views/*.ejs` | Individual page templates |
| `public/css/style.css` | Styling (identical across all versions) |
| `public/js/main.js` | AJAX logic for study tracker |
| `schema.sql` | Database schema (same design across all versions) |
| `.env` | Real secrets (never commit this) |
