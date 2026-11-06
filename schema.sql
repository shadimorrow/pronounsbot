CREATE TABLE IF NOT EXISTS user_rate_limits (
    user_id INTEGER PRIMARY KEY,
    last_request INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_updates (
    update_id INTEGER PRIMARY KEY,
    processed_at INTEGER NOT NULL
);
