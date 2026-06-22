const express  = require("express");
const cors     = require("cors");
const sqlite3  = require("sqlite3").verbose();
const path     = require("path");
const fs       = require("fs");
const bcrypt   = require("bcryptjs");
const session  = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "database.db");

const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  console.log(`📁 Created database directory: ${DB_DIR}`);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "alsl-admin-change-me";

const THRESHOLD_VALIDATED = parseInt(process.env.VALIDATION_THRESHOLD || "2", 10);
const THRESHOLD_REJECTED  = parseInt(process.env.REJECTED_THRESHOLD   || "3", 10);
const THRESHOLD_REVISION  = parseInt(process.env.REVISION_THRESHOLD   || "3", 10);
const THRESHOLD_FLAGGED   = parseInt(process.env.FLAGGED_THRESHOLD    || "2", 10);

async function getSignStatusMap() {
  return new Promise((resolve) => {
    const sql = `
      SELECT sign_id,
             SUM(CASE WHEN answer = 'YES'    THEN 1 ELSE 0 END) AS yes_n,
             SUM(CASE WHEN answer = 'NO'     THEN 1 ELSE 0 END) AS no_n,
             SUM(CASE WHEN answer = 'ALMOST' THEN 1 ELSE 0 END) AS almost_n,
             SUM(CASE WHEN answer = 'FLAG'   THEN 1 ELSE 0 END) AS flag_n,
             COUNT(DISTINCT CASE WHEN answer = 'YES'    THEN expert END) AS yes_experts,
             COUNT(DISTINCT CASE WHEN answer = 'NO'     THEN expert END) AS no_experts,
             COUNT(DISTINCT CASE WHEN answer = 'ALMOST' THEN expert END) AS almost_experts,
             COUNT(DISTINCT CASE WHEN answer = 'FLAG'   THEN expert END) AS flag_experts
      FROM evaluations
      GROUP BY sign_id
    `;
    db.all(sql, [], (err, rows) => {
      if (err) { console.error("getSignStatusMap:", err); return resolve(new Map()); }

      db.all(`SELECT sign_id, status FROM sign_overrides`, [], (err2, overrides) => {
        const ovMap = new Map((overrides || []).map(o => [o.sign_id, o.status]));
        const out = new Map();
        for (const r of rows) {
          const ov = ovMap.get(r.sign_id);
          let status = "active";
          if (ov) {
            status = ov;
          } else {
            if      (r.no_experts     >= THRESHOLD_REJECTED)  status = "rejected";
            else if (r.almost_experts >= THRESHOLD_REVISION)  status = "revision";
            else if (r.flag_experts   >= THRESHOLD_FLAGGED)   status = "flagged";
            else if (r.yes_experts    >= THRESHOLD_VALIDATED) status = "validated";
          }
          out.set(r.sign_id, {
            status,
            yes: r.yes_experts, no: r.no_experts,
            almost: r.almost_experts, flag: r.flag_experts,
            override: ov || null
          });
        }

        for (const [sid, ovStatus] of ovMap) {
          if (!out.has(sid)) {
            out.set(sid, { status: ovStatus, yes: 0, no: 0, almost: 0, flag: 0, override: ovStatus });
          }
        }
        resolve(out);
      });
    });
  });
}

async function getHiddenSignIds() {
  const map = await getSignStatusMap();
  const hidden = new Set();
  for (const [sid, info] of map) {
    if (info.status !== "active") hidden.add(sid);
  }
  return hidden;
}

async function getValidatedSignIds() {
  const map = await getSignStatusMap();
  const out = new Set();
  for (const [sid, info] of map) {
    if (info.status === "validated") out.add(sid);
  }
  return out;
}

const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip  = req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60_000) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > 200) return res.status(429).json({ success: false, error: "Too many requests" });
  next();
}

app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({
  store: new SQLiteStore({
    db: "sessions.db",
    dir: path.dirname(DB_PATH),
    concurrentDB: true
  }),
  secret: process.env.SESSION_SECRET || "alsl-thesis-2025-change-this-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
  }
}));

app.use(express.static(path.join(__dirname, "public")));
app.use("/videos", express.static(path.join(__dirname, "videos")));

function clean(str) {
  if (typeof str !== "string") return "";
  return str.trim().replace(/[<>"'`;\\]/g, "").slice(0, 500);
}
function cleanLong(str) {
  if (typeof str !== "string") return "";

  return str.trim().slice(0, 1000);
}
function validEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120;
}
const ALLOWED_ANSWERS = new Set(["YES", "NO", "ALMOST", "FLAG"]);
const ALLOWED_REASONS = new Set(["wrong_sign", "poor_quality", "other"]);

function requireAuth(req, res, next) {
  if (req.session && req.session.expert) return next();
  return res.status(401).json({ success: false, error: "Not logged in" });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect("/admin/login");
}

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      display_name  TEXT    NOT NULL,
      email         TEXT    DEFAULT '',
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''`, () => {});

  db.run(`ALTER TABLE users ADD COLUMN must_reset_password INTEGER DEFAULT 0`, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS signs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      concept_en TEXT NOT NULL,
      concept_ar TEXT NOT NULL,
      video      TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS evaluations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      expert       TEXT    NOT NULL,
      sign_id      INTEGER NOT NULL,
      concept      TEXT    NOT NULL,
      answer       TEXT    NOT NULL,
      comment      TEXT    DEFAULT '',
      flag_reasons TEXT    DEFAULT '',
      hamnosys     TEXT    DEFAULT '',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(expert, sign_id)
    )
  `);
  db.run(`ALTER TABLE evaluations ADD COLUMN flag_reasons TEXT DEFAULT ''`, () => {});
  db.run(`ALTER TABLE evaluations ADD COLUMN hamnosys     TEXT DEFAULT ''`, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS queue (
      cs_id      INTEGER PRIMARY KEY,
      french     TEXT    NOT NULL,
      queued_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      downloaded INTEGER  DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sign_overrides (
      sign_id    INTEGER PRIMARY KEY,
      status     TEXT NOT NULL,
      reason     TEXT DEFAULT '',
      set_by     TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("✅ Database ready");
  console.log(`🗄️  DB path: ${DB_PATH}`);

  autoRestoreFromCSVs();
});

function autoRestoreFromCSVs() {
  const dir = path.join(__dirname, "restore-data");
  const usersCsv = path.join(dir, "users.csv");
  const evalsCsv = path.join(dir, "evaluations.csv");

  if (!fs.existsSync(usersCsv) || !fs.existsSync(evalsCsv)) {
    return;
  }

  db.get("SELECT COUNT(*) as n FROM users", [], (err, row) => {
    if (err) { console.error("Auto-restore: count failed", err); return; }
    if (row && row.n > 0) {
      console.log(`ℹ️  Auto-restore skipped: ${row.n} users already in DB`);
      return;
    }
    console.log(`🔄 Auto-restore: empty DB detected, importing from CSVs…`);
    runRestore(usersCsv, evalsCsv);
  });
}

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", inQ = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i+1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { inQ = false; i++; continue; }
      cell += ch; i++;
    } else {
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ",")  { row.push(cell); cell = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
      cell += ch; i++;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length === headers.length || r.length > 1)
    .map(r => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] || "").trim()])));
}

function runRestore(usersCsv, evalsCsv) {
  const TEMP_PASSWORD = process.env.RESTORE_TEMP_PASSWORD || "alsl2026";
  let users = [], evals = [];
  try {
    users = parseCSV(fs.readFileSync(usersCsv, "utf8"));
    evals = parseCSV(fs.readFileSync(evalsCsv, "utf8"));
  } catch (e) { console.error("Auto-restore: CSV read failed", e.message); return; }

  console.log(`   ${users.length} users, ${evals.length} evaluations to import`);
  const hash = bcrypt.hashSync(TEMP_PASSWORD, 10);

  let uDone = 0;
  for (const u of users) {
    db.run(
      `INSERT OR IGNORE INTO users (username, password_hash, display_name, email, created_at, must_reset_password)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [u.username, hash, u.display_name, u.email || "", u.created_at || null],
      function(err) {
        uDone++;
        if (uDone === users.length) {
          console.log(`   ✅ Users restored (must_reset_password=1)`);
          let eDone = 0;
          if (evals.length === 0) { console.log(`   ✅ Auto-restore complete`); return; }
          for (const e of evals) {
            db.run(
              `INSERT OR IGNORE INTO evaluations (expert, sign_id, concept, answer, comment, flag_reasons, hamnosys, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                e.expert, parseInt(e.sign_id, 10), e.concept, e.answer,
                e.comment || "", e.flag_reasons || "", e.hamnosys || "", e.created_at || null
              ],
              function() {
                eDone++;
                if (eDone === evals.length) {
                  console.log(`   ✅ ${eDone} evaluations restored`);
                  console.log(`   🔑 Restored users have temp password: "${TEMP_PASSWORD}"`);
                  console.log(`      They'll be forced to set a new password on first login`);
                }
              }
            );
          }
        }
      }
    );
  }
}

app.post("/auth/register", rateLimit, (req, res) => {
  const username     = clean(req.body.username || "").toLowerCase();
  const display_name = clean(req.body.display_name || req.body.username || "");
  const email        = clean(req.body.email || "").toLowerCase();
  const password     = typeof req.body.password === "string" ? req.body.password.trim() : "";

  if (!username || username.length < 2)
    return res.status(400).json({ success: false, error: "Username too short" });
  if (!display_name)
    return res.status(400).json({ success: false, error: "Full name is required" });
  if (!email || !validEmail(email))
    return res.status(400).json({ success: false, error: "Invalid email address" });
  if (!password || password.length < 6)
    return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });

  db.get("SELECT id FROM users WHERE username = ?", [username], (err, row) => {
    if (err)  return res.status(500).json({ success: false, error: "Database error" });
    if (row)  return res.status(409).json({ success: false, error: "Username taken" });

    const hash = bcrypt.hashSync(password, 10);
    db.run(
      "INSERT INTO users (username, password_hash, display_name, email) VALUES (?, ?, ?, ?)",
      [username, hash, display_name, email],
      function(err2) {
        if (err2) return res.status(500).json({ success: false, error: "Database error" });
        req.session.expert   = display_name;
        req.session.username = username;
        req.session.user_id  = this.lastID;
        console.log(`✅ New user: ${username} <${email}>`);
        res.json({ success: true, expert: display_name });
      }
    );
  });
});

app.post("/auth/login", rateLimit, (req, res) => {
  const username = clean(req.body.username || "").toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password.trim() : "";

  if (!username || !password)
    return res.status(400).json({ success: false, error: "Missing username or password" });

  db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err)   return res.status(500).json({ success: false, error: "Database error" });
    if (!user) return res.status(401).json({ success: false, error: "Invalid credentials" });
    if (!bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ success: false, error: "Invalid credentials" });

    req.session.expert   = user.display_name;
    req.session.username = user.username;
    req.session.user_id  = user.id;
    console.log(`✅ Login: ${username}${user.must_reset_password ? " (must reset password)" : ""}`);
    res.json({
      success: true,
      expert: user.display_name,
      must_reset_password: user.must_reset_password === 1
    });
  });
});

app.post("/auth/set-new-password", requireAuth, rateLimit, (req, res) => {
  const newPassword = typeof req.body.new_password === "string" ? req.body.new_password.trim() : "";
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  const userId = req.session.user_id;
  db.run(
    `UPDATE users SET password_hash = ?, must_reset_password = 0 WHERE id = ?`,
    [hash, userId],
    function(err) {
      if (err) return res.status(500).json({ success: false, error: "Database error" });
      console.log(`✅ Password reset for user_id=${userId}`);
      res.json({ success: true });
    }
  );
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/auth/me", (req, res) => {
  if (req.session && req.session.expert) {
    db.get(
      `SELECT must_reset_password FROM users WHERE id = ?`,
      [req.session.user_id],
      (err, row) => {
        return res.json({
          success: true,
          expert: req.session.expert,
          must_reset_password: row && row.must_reset_password === 1
        });
      }
    );
    return;
  }
  res.json({ success: false });
});

app.get("/signs.json", async (req, res) => {
  const hiddenIds = await getHiddenSignIds();
  db.all("SELECT * FROM signs ORDER BY id", [], (err, rows) => {
    if (err || rows.length === 0) {
      try {
        const raw = fs.readFileSync(path.join(__dirname, "public", "signs.json"), "utf8");
        const all = JSON.parse(raw);
        const filtered = all.filter(s => !hiddenIds.has(s.id));
        return res.json(filtered);
      } catch (e) {
        return res.sendFile(path.join(__dirname, "public", "signs.json"));
      }
    }
    const filtered = rows.filter(s => !hiddenIds.has(s.id));
    res.json(filtered);
  });
});

app.get("/validated-ids", requireAuth, async (req, res) => {
  const ids = await getHiddenSignIds();
  res.json({ success: true, ids: Array.from(ids) });
});

app.post("/save", requireAuth, rateLimit, (req, res) => {
  const expert  = req.session.expert;
  const sign_id = parseInt(req.body.sign_id, 10);
  const concept = clean(req.body.concept);
  const answer  = String(req.body.answer || "").toUpperCase();
  const comment = cleanLong(req.body.comment || "");

  if (isNaN(sign_id) || sign_id < 1) return res.status(400).json({ success: false, error: "Invalid: sign_id" });
  if (!ALLOWED_ANSWERS.has(answer))  return res.status(400).json({ success: false, error: "Invalid: answer" });

  const rawReasons = Array.isArray(req.body.flag_reasons) ? req.body.flag_reasons : [];
  const reasons    = rawReasons.filter(r => ALLOWED_REASONS.has(r)).join(",");

  const sql = `
    INSERT INTO evaluations (expert, sign_id, concept, answer, comment, flag_reasons)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(expert, sign_id) DO UPDATE SET
      answer = excluded.answer, comment = excluded.comment,
      flag_reasons = excluded.flag_reasons, created_at = CURRENT_TIMESTAMP
  `;
  db.run(sql, [expert, sign_id, concept, answer, comment, reasons], function(err) {
    if (err) return res.status(500).json({ success: false, error: "Database error" });
    console.log(`✅ ${expert} → Sign ${sign_id} [${answer}]`);
    res.json({ success: true });
  });
});

app.get("/progress/:expert", requireAuth, rateLimit, async (req, res) => {
  const expert = req.session.expert;
  const hiddenIds = await getHiddenSignIds();
  db.all("SELECT sign_id, answer, comment FROM evaluations WHERE expert = ?", [expert], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: "Database error" });
    const visible = rows.filter(r => !hiddenIds.has(r.sign_id));
    res.json({
      success:   true,
      evaluated: visible.map(r => r.sign_id),
      answers:   Object.fromEntries(visible.map(r => [r.sign_id, r.answer])),
      comments:  Object.fromEntries(visible.map(r => [r.sign_id, r.comment || ""]))
    });
  });
});

app.get("/evaluations", requireAuth, rateLimit, (req, res) => {
  const expert = req.session.expert;
  db.all(
    "SELECT * FROM evaluations WHERE expert = ? ORDER BY created_at DESC",
    [expert], (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: "Database error" });
      res.json({ success: true, data: rows });
    }
  );
});

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function rowsToCsv(rows, columns) {
  const header = columns.join(",");
  const lines = rows.map(r => columns.map(c => csvEscape(r[c])).join(","));
  return "\uFEFF" + header + "\n" + lines.join("\n") + "\n";
}

app.get("/my-work.csv", requireAuth, (req, res) => {
  const expert = req.session.expert;
  db.all(
    "SELECT * FROM evaluations WHERE expert = ? ORDER BY sign_id",
    [expert],
    (err, rows) => {
      if (err) return res.status(500).send("Database error");
      const csv = rowsToCsv(rows, ["id","expert","sign_id","concept","answer","comment","flag_reasons","hamnosys","created_at"]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="my-work-${expert}.csv"`);
      res.send(csv);
    }
  );
});

app.get("/admin/login", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin — Login</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b0e17;color:#e6ecff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#141a28;border:1px solid #232b42;border-radius:14px;padding:32px 28px;min-width:320px;box-shadow:0 12px 40px rgba(0,0,0,0.4)}
h1{font-size:1.15rem;margin:0 0 6px;color:#8fa4ff}
p{font-size:.82rem;color:#8a94b0;margin:0 0 18px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #2a334c;background:#1a2236;color:#e6ecff;font-size:.95rem;box-sizing:border-box;margin-bottom:10px}
button{width:100%;padding:10px;background:#6b83e8;color:white;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:.95rem}
button:hover{background:#5a7ce0}
.err{color:#f87171;font-size:.82rem;min-height:18px;margin:-4px 0 8px;text-align:center}
</style></head><body>
<form class="box" method="POST" action="/admin/login">
<h1>🔒 Admin Access</h1>
<p>Enter admin password to view statistics & exports</p>
<input type="password" name="password" placeholder="Admin password" autofocus required>
${req.query.err ? '<div class="err">Wrong password</div>' : ""}
<button type="submit">Enter</button>
</form></body></html>`);
});

app.post("/admin/login", rateLimit, (req, res) => {
  const pw = typeof req.body.password === "string" ? req.body.password : "";
  if (pw === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.redirect("/admin");
  }
  return res.redirect("/admin/login?err=1");
});

app.post("/admin/logout", (req, res) => {
  if (req.session) req.session.admin = false;
  res.redirect("/admin/login");
});

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "admin.html"));
});

app.get("/admin/stats.json", requireAdmin, async (req, res) => {
  const out = {};
  out.thresholds = {
    validated: THRESHOLD_VALIDATED,
    rejected:  THRESHOLD_REJECTED,
    revision:  THRESHOLD_REVISION,
    flagged:   THRESHOLD_FLAGGED
  };

  out.validationThreshold = THRESHOLD_VALIDATED;

  const statusMap = await getSignStatusMap();

  db.all("SELECT username, display_name, email, created_at FROM users ORDER BY created_at", [], (err, users) => {
    if (err) return res.status(500).json({ error: "DB error" });
    out.users = users || [];
    db.all(
      `SELECT expert, answer, COUNT(*) as n FROM evaluations GROUP BY expert, answer`,
      [], (err2, rows) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        const byExpert = {};
        for (const r of rows) {
          if (!byExpert[r.expert]) byExpert[r.expert] = { YES: 0, NO: 0, ALMOST: 0, FLAG: 0, total: 0 };
          byExpert[r.expert][r.answer] = r.n;
          byExpert[r.expert].total += r.n;
        }
        out.byExpert = byExpert;
        db.get(`SELECT COUNT(*) as total_signs FROM signs`, [], (e3, s) => {
          out.totalSigns = (s && s.total_signs) || 0;
          db.get(`SELECT COUNT(*) as total_evals FROM evaluations`, [], (e4, e) => {
            out.totalEvaluations = (e && e.total_evals) || 0;

            db.all(`SELECT sign_id, concept FROM evaluations`, [], (e4b, signRows) => {
              const conceptMap = new Map();
              for (const r of signRows || []) {
                if (!conceptMap.has(r.sign_id)) conceptMap.set(r.sign_id, r.concept);
              }
              const buckets = { validated: [], rejected: [], revision: [], flagged: [] };
              for (const [sid, info] of statusMap) {
                if (info.status === "active") continue;
                const item = {
                  sign_id: sid,
                  concept: conceptMap.get(sid) || "—",
                  yes: info.yes, no: info.no, almost: info.almost, flag: info.flag,
                  override: info.override
                };
                if (buckets[info.status]) buckets[info.status].push(item);
              }
              for (const k of Object.keys(buckets)) {
                buckets[k].sort((a, b) => a.sign_id - b.sign_id);
              }
              out.buckets = buckets;
              out.validatedCount = buckets.validated.length;
              out.rejectedCount  = buckets.rejected.length;
              out.revisionCount  = buckets.revision.length;
              out.flaggedCount   = buckets.flagged.length;

              out.validated = buckets.validated.map(v => ({
                sign_id: v.sign_id, concept: v.concept, yes_count: v.yes
              }));

              db.all(
                `SELECT id, expert, sign_id, concept, answer, comment, flag_reasons, created_at
                 FROM evaluations ORDER BY created_at DESC LIMIT 100`,
                [], (e6, recent) => {
                  out.recent = recent || [];
                  res.json(out);
                }
              );
            });
          });
        });
      }
    );
  });
});

app.get("/admin/export-all.csv", requireAdmin, (req, res) => {
  db.all("SELECT * FROM evaluations ORDER BY expert, sign_id", [], (err, rows) => {
    if (err) return res.status(500).send("Database error");
    const csv = rowsToCsv(rows, ["id","expert","sign_id","concept","answer","comment","flag_reasons","hamnosys","created_at"]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="alsl-all-evaluations.csv"`);
    res.send(csv);
  });
});

app.get("/admin/validated.csv", requireAdmin, async (req, res) => {
  const map = await getSignStatusMap();
  const list = [];
  for (const [sid, info] of map) {
    if (info.status === "validated") list.push({ sign_id: sid, yes: info.yes, no: info.no, almost: info.almost, flag: info.flag });
  }
  list.sort((a, b) => a.sign_id - b.sign_id);

  db.all(`SELECT sign_id, concept FROM evaluations`, [], (e, rows) => {
    const conceptMap = new Map();
    for (const r of (rows || [])) if (!conceptMap.has(r.sign_id)) conceptMap.set(r.sign_id, r.concept);
    const out = list.map(x => ({ ...x, concept: conceptMap.get(x.sign_id) || "" }));
    const csv = rowsToCsv(out, ["sign_id","concept","yes","no","almost","flag"]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="alsl-validated.csv"`);
    res.send(csv);
  });
});

function exportBucket(req, res, statusName, filename) {
  getSignStatusMap().then(map => {
    const list = [];
    for (const [sid, info] of map) {
      if (info.status === statusName) list.push({ sign_id: sid, yes: info.yes, no: info.no, almost: info.almost, flag: info.flag });
    }
    list.sort((a, b) => a.sign_id - b.sign_id);
    db.all(`SELECT sign_id, concept FROM evaluations`, [], (e, rows) => {
      const conceptMap = new Map();
      for (const r of (rows || [])) if (!conceptMap.has(r.sign_id)) conceptMap.set(r.sign_id, r.concept);
      const out = list.map(x => ({ ...x, concept: conceptMap.get(x.sign_id) || "" }));
      const csv = rowsToCsv(out, ["sign_id","concept","yes","no","almost","flag"]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    });
  });
}
app.get("/admin/rejected.csv", requireAdmin, (req, res) => exportBucket(req, res, "rejected", "alsl-rejected.csv"));
app.get("/admin/revision.csv", requireAdmin, (req, res) => exportBucket(req, res, "revision", "alsl-revision.csv"));
app.get("/admin/flagged.csv",  requireAdmin, (req, res) => exportBucket(req, res, "flagged",  "alsl-flagged.csv"));

app.post("/admin/sign/:id/override", requireAdmin, (req, res) => {
  const sign_id = parseInt(req.params.id, 10);
  const status  = String(req.body.status || "").trim().toLowerCase();
  const reason  = clean(req.body.reason || "");
  if (isNaN(sign_id) || sign_id < 1) return res.status(400).json({ success: false, error: "Invalid sign_id" });
  const allowed = new Set(["active", "validated", "rejected", "revision", "flagged"]);
  if (!allowed.has(status)) return res.status(400).json({ success: false, error: "Invalid status" });

  db.run(
    `INSERT INTO sign_overrides (sign_id, status, reason, set_by, created_at)
     VALUES (?, ?, ?, 'admin', CURRENT_TIMESTAMP)
     ON CONFLICT(sign_id) DO UPDATE SET status=excluded.status, reason=excluded.reason, created_at=CURRENT_TIMESTAMP`,
    [sign_id, status, reason],
    function(err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      console.log(`✅ Admin override: sign ${sign_id} → ${status} (${reason})`);
      res.json({ success: true });
    }
  );
});

app.delete("/admin/sign/:id/override", requireAdmin, (req, res) => {
  const sign_id = parseInt(req.params.id, 10);
  if (isNaN(sign_id) || sign_id < 1) return res.status(400).json({ success: false, error: "Invalid sign_id" });
  db.run(`DELETE FROM sign_overrides WHERE sign_id = ?`, [sign_id], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    console.log(`✅ Admin override cleared: sign ${sign_id}`);
    res.json({ success: true });
  });
});

app.delete("/admin/evaluation/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 1) return res.status(400).json({ success: false, error: "Invalid id" });
  db.run(`DELETE FROM evaluations WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    console.log(`✅ Admin deleted evaluation #${id}`);
    res.json({ success: true, deleted: this.changes });
  });
});

app.get("/admin/sign/:id", requireAdmin, async (req, res) => {
  const sign_id = parseInt(req.params.id, 10);
  if (isNaN(sign_id) || sign_id < 1) return res.status(400).json({ success: false, error: "Invalid sign_id" });
  db.all(
    `SELECT id, expert, answer, comment, flag_reasons, created_at
       FROM evaluations WHERE sign_id = ? ORDER BY created_at`,
    [sign_id],
    (err, rows) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      db.get(`SELECT * FROM sign_overrides WHERE sign_id = ?`, [sign_id], (e2, override) => {
        const map = {};
        for (const r of rows) map[r.answer] = (map[r.answer] || 0) + 1;
        res.json({
          success: true,
          sign_id,
          evaluations: rows,
          counts: map,
          override: override || null
        });
      });
    }
  );
});

app.delete("/admin/user/:username", requireAdmin, (req, res) => {
  const username = req.params.username;
  const alsoDeleteEvals = req.query.delete_evals === "1";
  db.get(`SELECT display_name FROM users WHERE username = ?`, [username], (e, user) => {
    if (e) return res.status(500).json({ success: false, error: e.message });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const display = user.display_name;
    db.run(`DELETE FROM users WHERE username = ?`, [username], function(err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      if (alsoDeleteEvals) {
        db.run(`DELETE FROM evaluations WHERE expert = ?`, [display], function(err2) {
          if (err2) return res.status(500).json({ success: false, error: err2.message });
          console.log(`✅ Deleted user ${username} + ${this.changes} evaluations`);
          res.json({ success: true, deleted_user: 1, deleted_evals: this.changes });
        });
      } else {
        console.log(`✅ Deleted user ${username} (kept evaluations)`);
        res.json({ success: true, deleted_user: 1 });
      }
    });
  });
});

app.get("/admin/export/:expert.csv", requireAdmin, (req, res) => {
  const expert = req.params.expert;
  db.all("SELECT * FROM evaluations WHERE expert = ? ORDER BY sign_id", [expert], (err, rows) => {
    if (err) return res.status(500).send("Database error");
    const csv = rowsToCsv(rows, ["id","expert","sign_id","concept","answer","comment","flag_reasons","hamnosys","created_at"]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="alsl-${expert}.csv"`);
    res.send(csv);
  });
});

app.delete("/admin/expert/:username", requireAdmin, (req, res) => {
  const username = req.params.username;
  db.get("SELECT id, display_name FROM users WHERE username = ?", [username], (err, user) => {
    if (err) return res.status(500).json({ success: false, error: "DB error" });
    if (!user) return res.status(404).json({ success: false, error: "Expert not found" });
    db.run("DELETE FROM evaluations WHERE expert = ?", [user.display_name], (err2) => {
      if (err2) return res.status(500).json({ success: false, error: "DB error deleting evaluations" });
      db.run("DELETE FROM users WHERE username = ?", [username], (err3) => {
        if (err3) return res.status(500).json({ success: false, error: "DB error deleting user" });
        console.log(`🗑️  Admin deleted expert: ${username}`);
        res.json({ success: true });
      });
    });
  });
});

app.post("/admin/expert/:username/reset-password", requireAdmin, (req, res) => {
  const username = req.params.username;
  const newPassword = typeof req.body.new_password === "string" ? req.body.new_password.trim() : "";
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
  }
  db.get(`SELECT id, display_name FROM users WHERE username = ?`, [username], (err, user) => {
    if (err)   return res.status(500).json({ success: false, error: err.message });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });
    const hash = bcrypt.hashSync(newPassword, 10);
    db.run(
      `UPDATE users SET password_hash = ?, must_reset_password = 1 WHERE id = ?`,
      [hash, user.id],
      function(err2) {
        if (err2) return res.status(500).json({ success: false, error: err2.message });
        console.log(`🔑 Admin reset password for ${username} (${user.display_name})`);
        res.json({ success: true, display_name: user.display_name });
      }
    );
  });
});

app.delete("/admin/evaluation/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: "Invalid id" });
  db.run("DELETE FROM evaluations WHERE id = ?", [id], function(err) {
    if (err) return res.status(500).json({ success: false, error: "DB error" });
    if (this.changes === 0) return res.status(404).json({ success: false, error: "Evaluation not found" });
    res.json({ success: true });
  });
});

app.get("/admin/expert/:username/evaluations", requireAdmin, (req, res) => {
  const username = req.params.username;
  db.get("SELECT display_name FROM users WHERE username = ?", [username], (err, user) => {
    if (err) return res.status(500).json({ success: false, error: "DB error" });
    if (!user) return res.status(404).json({ success: false, error: "Expert not found" });
    db.all(
      "SELECT id, sign_id, concept, answer, comment, flag_reasons, created_at FROM evaluations WHERE expert = ? ORDER BY sign_id",
      [user.display_name],
      (err2, rows) => {
        if (err2) return res.status(500).json({ success: false, error: "DB error" });
        res.json({ success: true, evaluations: rows || [], expert: user.display_name });
      }
    );
  });
});

app.get("/admin/users.csv", requireAdmin, (req, res) => {
  db.all("SELECT id, username, display_name, email, created_at FROM users ORDER BY created_at", [], (err, rows) => {
    if (err) return res.status(500).send("Database error");
    const csv = rowsToCsv(rows, ["id","username","display_name","email","created_at"]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="alsl-users.csv"`);
    res.send(csv);
  });
});

const extCors = cors({ origin: true, credentials: false });
app.options("/queue",  extCors);
app.options("/queued", extCors);
app.post("/queue", extCors, rateLimit, (req, res) => {
  const cs_id  = parseInt(req.body.cs_id, 10);
  const french = clean(req.body.french || "");
  if (isNaN(cs_id) || cs_id < 1) return res.status(400).json({ success: false, error: "Invalid cs_id" });
  db.run("INSERT OR IGNORE INTO queue (cs_id, french) VALUES (?, ?)", [cs_id, french], function(err) {
    if (err) return res.status(500).json({ success: false, error: "DB error" });
    res.json({ success: true, queued: this.changes > 0 });
  });
});
app.get("/queued", extCors, (req, res) => {
  db.all("SELECT * FROM queue ORDER BY queued_at DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: "DB error" });
    res.json({ success: true, data: rows });
  });
});

const BACKUP_DIR = path.join(path.dirname(DB_PATH), "backups");
const KEEP_DAYS  = 7;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function backupToVolume() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `database-${todayISO()}.db`);

    if (fs.existsSync(dest)) fs.unlinkSync(dest);

    await new Promise((resolve, reject) => {
      db.run(`VACUUM INTO ?`, [dest], (err) => err ? reject(err) : resolve());
    });

    console.log(`💾 Volume backup → ${dest} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^database-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    while (files.length > KEEP_DAYS) {
      const old = files.shift();
      fs.unlinkSync(path.join(BACKUP_DIR, old));
      console.log(`   pruned old backup: ${old}`);
    }
  } catch (e) {
    console.error(`⚠️  Volume backup failed: ${e.message}`);
  }
}

async function backupToGitHub() {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";

  if (!token || !repo) return;

  const csvFiles = await Promise.all([
    new Promise(resolve => {
      db.all(`SELECT * FROM evaluations ORDER BY expert, sign_id`, [], (err, rows) => {
        const csv = err ? "" : rowsToCsv(rows || [], ["id","expert","sign_id","concept","answer","comment","flag_reasons","hamnosys","created_at"]);
        resolve({ name: `evaluations-${todayISO()}.csv`, content: csv });
      });
    }),
    new Promise(resolve => {
      db.all(`SELECT id, username, display_name, email, created_at FROM users ORDER BY created_at`, [], (err, rows) => {
        const csv = err ? "" : rowsToCsv(rows || [], ["id","username","display_name","email","created_at"]);
        resolve({ name: `users-${todayISO()}.csv`, content: csv });
      });
    })
  ]);

  for (const file of csvFiles) {
    if (!file.content) continue;
    try {
      const githubPath = `backups/${file.name}`;
      const apiUrl = `https://api.github.com/repos/${repo}/contents/${githubPath}`;

      let existingSha = null;
      try {
        const headRes = await fetch(`${apiUrl}?ref=${branch}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
        });
        if (headRes.ok) {
          const headData = await headRes.json();
          existingSha = headData.sha;
        }
      } catch (e) {  }

      const body = {
        message: `Daily backup: ${file.name}`,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        branch,
      };
      if (existingSha) body.sha = existingSha;

      const res = await fetch(apiUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        console.log(`☁️  GitHub backup → ${repo}:${githubPath}`);
      } else {
        const err = await res.text();
        console.error(`⚠️  GitHub backup failed for ${file.name}: ${res.status} ${err.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`⚠️  GitHub backup error: ${e.message}`);
    }
  }
}

async function runBackups() {
  await backupToVolume();
  await backupToGitHub();
}

setTimeout(() => {
  runBackups();
  setInterval(runBackups, 24 * 60 * 60 * 1000);
}, 60_000);

app.post("/admin/backup-now", requireAdmin, async (req, res) => {
  console.log(`🔄 Manual backup triggered by admin`);
  await runBackups();
  res.json({ success: true });
});

app.get("/admin/backups", requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json({ success: true, backups: [] });
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^database-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse()
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size_kb: Math.round(stat.size / 1024), modified: stat.mtime };
      });
    res.json({ success: true, backups: files });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/admin/backups/:filename", requireAdmin, (req, res) => {
  const fname = req.params.filename;
  if (!/^database-\d{4}-\d{2}-\d{2}\.db$/.test(fname)) {
    return res.status(400).send("Invalid backup filename");
  }
  const fpath = path.join(BACKUP_DIR, fname);
  if (!fs.existsSync(fpath)) return res.status(404).send("Backup not found");
  res.download(fpath);
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Server → http://localhost:${PORT}`);
  console.log(`🌍 HOST: ${HOST}`);
  console.log(`🔑 Admin password: ${ADMIN_PASSWORD === "alsl-admin-change-me" ? "(using default, set ADMIN_PASSWORD env var!)" : "(from env)"}`);
  console.log(`✅ Thresholds — validated:${THRESHOLD_VALIDATED}YES, rejected:${THRESHOLD_REJECTED}NO, revision:${THRESHOLD_REVISION}ALMOST, flagged:${THRESHOLD_FLAGGED}FLAG`);
  console.log(`💾 Volume backups: ${BACKUP_DIR} (keep last ${KEEP_DAYS} days)`);
  console.log(`☁️  GitHub backups: ${process.env.GITHUB_TOKEN && process.env.GITHUB_REPO ? "enabled → " + process.env.GITHUB_REPO : "disabled (set GITHUB_TOKEN + GITHUB_REPO to enable)"}`);
  if (process.env.NODE_ENV === "production") {
    console.log("🔒 Running in production mode");
  }
});

app.use((req, res) => res.status(404).json({ success: false, error: "Not found" }));
