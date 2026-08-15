# StudyHub (Node.js + Express + MySQL version)

Same project — department-wise academic resources + personal study tracker — rebuilt with Node.js backend.

## Setup

1. **Install Node.js** (v18+) from nodejs.org if not already installed. Check with:
   ```bash
   node --version
   ```

2. **Install MySQL** (or use XAMPP's MySQL — only start MySQL, not Apache).

3. **Install dependencies**
   ```bash
   cd studyhub_node
   npm install
   ```

4. **Create the database**
   - Open phpMyAdmin
   - Import `schema.sql` — creates the `studyhub` database + all 4 tables.

5. **Set up environment variables**
   - Copy `.env.example` to a new file named `.env`
   - Fill in your actual DB credentials:
     ```
     DB_HOST=localhost
     DB_USER=root
     DB_PASS=
     DB_NAME=studyhub
     SESSION_SECRET=any_random_string_here
     PORT=3000
     ```

6. **Run the app**
   ```bash
   npm start
   ```
   Visit `http://localhost:3000/`

7. **Create an admin account**
   - Register normally first.
   - phpMyAdmin → `studyhub` → `users` table → edit your row → change `role` to `admin`.

## Folder Structure

```
studyhub_node/
├── server.js              # All routes + logic (equivalent to app.py / all .php files)
├── package.json
├── .env.example            # Copy to .env and fill in real values
├── schema.sql
├── views/                   # EJS templates (equivalent to Jinja2 templates)
│   ├── _header.ejs, _footer.ejs   # Shared navbar/footer (like base.html)
│   ├── index.ejs, register.ejs, login.ejs
│   ├── dashboard.ejs, resources.ejs, upload.ejs, admin.ejs, progress.ejs
├── public/
│   ├── css/style.css        # Same styling as PHP/Flask versions
│   └── js/main.js           # Same AJAX logic
└── uploads/                  # Uploaded PDFs land here
```

## Concept Mapping (for interview explanation)

| Concept | PHP | Flask | Node.js (this version) |
|---|---|---|---|
| Routing | One `.php` file per URL | `@app.route()` decorators | `app.get()` / `app.post()` |
| Templating | HTML + `<?php ?>` | Jinja2 (`{{ }}`) | EJS (`<%= %>`) |
| Sessions | `$_SESSION` | Flask `session` | `express-session` (`req.session`) |
| DB queries | `mysqli` + `bind_param()` | `mysql-connector` + `%s` | `mysql2` + `?` placeholders — all parameterized, same SQL injection protection |
| Password hashing | `password_hash()` | `generate_password_hash()` | `bcrypt.hash()` |
| File upload | `$_FILES` + `move_uploaded_file()` | `request.files` | `multer` middleware |
| Async style | Synchronous (blocking) | Synchronous (blocking) | **Asynchronous** (`async/await`) — Node's biggest architectural difference |

**Key interview point:** Node.js is fundamentally different from PHP/Flask in one important way — it's **non-blocking/asynchronous** by default. While a database query runs, Node can handle other incoming requests instead of waiting idle. That's why every DB call here uses `await pool.query(...)` — the pool of connections + async/await lets multiple users hit the server without one slow request blocking everyone else.
