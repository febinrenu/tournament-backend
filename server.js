const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Rate limiting to handle high concurrent load
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Initialize SQLite Database
const db = new sqlite3.Database('./tournament_scores.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    initializeDatabase();
  }
});

function initializeDatabase() {
  // Create scores table if it doesn't exist
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS tournament_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_number TEXT UNIQUE NOT NULL,
      student_name TEXT,
      final_score INTEGER NOT NULL,
      levels_completed INTEGER NOT NULL,
      accuracy_rate REAL NOT NULL,
      time_remaining INTEGER NOT NULL,
      level_breakdown TEXT, -- JSON string of level performance
      completion_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      session_id TEXT
    )
  `;
  
  db.run(createTableQuery, (err) => {
    if (err) {
      console.error('Error creating table:', err.message);
    } else {
      console.log('Tournament scores table ready.');
    }
  });

  // Create index for better performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_final_score ON tournament_scores(final_score DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_completion_time ON tournament_scores(completion_time DESC)`);
}

// API Routes

// Submit tournament score
app.post('/api/submit-score', (req, res) => {
  const {
    registrationNumber,
    studentName,
    finalScore,
    levelsCompleted,
    accuracyRate,
    timeRemaining,
    levelBreakdown,
    sessionId
  } = req.body;

  // Validation
  if (!registrationNumber || finalScore === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'Registration number and final score are required.' 
    });
  }

  const clientIP = req.ip || req.connection.remoteAddress;
  
  // Insert or update score (upsert)
  const upsertQuery = `
    INSERT INTO tournament_scores 
    (registration_number, student_name, final_score, levels_completed, accuracy_rate, 
     time_remaining, level_breakdown, ip_address, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(registration_number) DO UPDATE SET
      student_name = excluded.student_name,
      final_score = CASE 
        WHEN excluded.final_score > final_score THEN excluded.final_score 
        ELSE final_score 
      END,
      levels_completed = excluded.levels_completed,
      accuracy_rate = excluded.accuracy_rate,
      time_remaining = excluded.time_remaining,
      level_breakdown = excluded.level_breakdown,
      completion_time = CURRENT_TIMESTAMP,
      ip_address = excluded.ip_address,
      session_id = excluded.session_id
  `;

  db.run(upsertQuery, [
    registrationNumber,
    studentName || 'Anonymous',
    finalScore,
    levelsCompleted || 0,
    accuracyRate || 0,
    timeRemaining || 0,
    JSON.stringify(levelBreakdown || {}),
    clientIP,
    sessionId
  ], function(err) {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).json({ 
        success: false, 
        message: 'Error saving score to database.' 
      });
    }

    res.json({
      success: true,
      message: 'Score submitted successfully!',
      scoreId: this.lastID,
      rank: null // Will be calculated in leaderboard
    });
  });
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;

  const leaderboardQuery = `
    SELECT 
      ROW_NUMBER() OVER (ORDER BY final_score DESC, completion_time ASC) as rank,
      registration_number,
      student_name,
      final_score,
      levels_completed,
      accuracy_rate,
      time_remaining,
      level_breakdown,
      completion_time
    FROM tournament_scores 
    ORDER BY final_score DESC, completion_time ASC
    LIMIT ? OFFSET ?
  `;

  db.all(leaderboardQuery, [limit, offset], (err, rows) => {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).json({ 
        success: false, 
        message: 'Error fetching leaderboard.' 
      });
    }

    // Parse level breakdown JSON
    const leaderboard = rows.map(row => ({
      ...row,
      level_breakdown: JSON.parse(row.level_breakdown || '{}')
    }));

    res.json({
      success: true,
      leaderboard: leaderboard,
      total: leaderboard.length
    });
  });
});

// Get total participants count
app.get('/api/stats', (req, res) => {
  const statsQuery = `
    SELECT 
      COUNT(*) as total_participants,
      MAX(final_score) as highest_score,
      AVG(final_score) as average_score,
      AVG(levels_completed) as average_levels_completed,
      AVG(accuracy_rate) as average_accuracy
    FROM tournament_scores
  `;

  db.get(statsQuery, (err, row) => {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).json({ 
        success: false, 
        message: 'Error fetching statistics.' 
      });
    }

    res.json({
      success: true,
      stats: row
    });
  });
});

// Get individual student rank
app.get('/api/rank/:registrationNumber', (req, res) => {
  const registrationNumber = req.params.registrationNumber;

  const rankQuery = `
    SELECT 
      rank,
      registration_number,
      student_name,
      final_score,
      levels_completed,
      accuracy_rate,
      time_remaining,
      completion_time
    FROM (
      SELECT 
        ROW_NUMBER() OVER (ORDER BY final_score DESC, completion_time ASC) as rank,
        *
      FROM tournament_scores
    ) ranked_scores
    WHERE registration_number = ?
  `;

  db.get(rankQuery, [registrationNumber], (err, row) => {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).json({ 
        success: false, 
        message: 'Error fetching rank.' 
      });
    }

    if (!row) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found in leaderboard.' 
      });
    }

    res.json({
      success: true,
      student: row
    });
  });
});

// Serve the leaderboard HTML page
app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'leaderboard.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Server is running', timestamp: new Date().toISOString() });
});

// =================
// DATABASE CLEARING ENDPOINTS
// =================

// Clear all tournament data (Admin endpoint)
app.delete('/api/admin/clear-all', (req, res) => {
  const adminKey = req.query.key || req.headers['admin-key'];
  
  // Simple admin key check (you can change this)
  if (adminKey !== 'IEEE2025ADMIN') {
    return res.status(403).json({
      success: false,
      message: 'Unauthorized. Admin key required.'
    });
  }

  const clearQuery = 'DELETE FROM tournament_scores';
  
  db.run(clearQuery, (err) => {
    if (err) {
      console.error('Error clearing database:', err.message);
      return res.status(500).json({
        success: false,
        message: 'Error clearing database.'
      });
    }

    console.log('🗑️ Database cleared by admin');
    res.json({
      success: true,
      message: 'All tournament data has been cleared successfully.',
      timestamp: new Date().toISOString()
    });
  });
});

// Clear specific student record
app.delete('/api/admin/clear-student', (req, res) => {
  const adminKey = req.query.key || req.headers['admin-key'];
  const registrationNumber = req.query.reg || req.body.registrationNumber;
  
  if (adminKey !== 'IEEE2025ADMIN') {
    return res.status(403).json({
      success: false,
      message: 'Unauthorized. Admin key required.'
    });
  }

  if (!registrationNumber) {
    return res.status(400).json({
      success: false,
      message: 'Registration number is required.'
    });
  }

  const deleteQuery = 'DELETE FROM tournament_scores WHERE registration_number = ?';
  
  db.run(deleteQuery, [registrationNumber], function(err) {
    if (err) {
      console.error('Error deleting student record:', err.message);
      return res.status(500).json({
        success: false,
        message: 'Error deleting student record.'
      });
    }

    if (this.changes === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student not found.'
      });
    }

    console.log(`🗑️ Student record deleted: ${registrationNumber}`);
    res.json({
      success: true,
      message: `Student record for ${registrationNumber} has been deleted.`,
      deletedRecords: this.changes
    });
  });
});

// Get database backup (export data)
app.get('/api/admin/backup', (req, res) => {
  const adminKey = req.query.key || req.headers['admin-key'];
  
  if (adminKey !== 'IEEE2025ADMIN') {
    return res.status(403).json({
      success: false,
      message: 'Unauthorized. Admin key required.'
    });
  }

  const backupQuery = 'SELECT * FROM tournament_scores ORDER BY completion_time DESC';
  
  db.all(backupQuery, (err, rows) => {
    if (err) {
      console.error('Error creating backup:', err.message);
      return res.status(500).json({
        success: false,
        message: 'Error creating backup.'
      });
    }

    const backup = {
      exportDate: new Date().toISOString(),
      totalRecords: rows.length,
      data: rows.map(row => ({
        ...row,
        level_breakdown: JSON.parse(row.level_breakdown || '{}')
      }))
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="tournament_backup_${new Date().toISOString().split('T')[0]}.json"`);
    res.json(backup);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Closing database connection...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed.');
    }
    process.exit(0);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Tournament server running on http://localhost:${PORT}`);
  console.log(`📊 Leaderboard available at http://localhost:${PORT}/leaderboard`);
  console.log(`🏆 Ready to handle 600+ concurrent students!`);
});
