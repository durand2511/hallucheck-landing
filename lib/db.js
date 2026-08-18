const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://localhost/vankonijnenburg",
});

module.exports = { pool };
