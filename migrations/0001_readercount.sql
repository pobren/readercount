-- ReaderCount: everything it keeps, in your own D1 database.
-- No cookies and nothing personal about readers: `visitor` is a hash that changes every day (src/visitor.ts).

-- One row per page view, link click, file download or goal.
CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY,
	site TEXT NOT NULL,
	ts INTEGER NOT NULL,
	day TEXT NOT NULL,
	kind TEXT NOT NULL,
	visitor TEXT NOT NULL,
	view_id TEXT,
	path TEXT NOT NULL,
	target TEXT,
	referrer TEXT,
	source TEXT,
	utm_medium TEXT,
	utm_campaign TEXT,
	country TEXT,
	device TEXT,
	browser TEXT,
	os TEXT,
	duration INTEGER,
	-- 1 when the page said "not found".
	missing INTEGER,
	-- When the reader left the page (live view), how far they scrolled, and Core Web Vitals.
	left_at INTEGER,
	scroll INTEGER,
	lcp INTEGER,
	inp INTEGER,
	cls INTEGER
);
CREATE INDEX IF NOT EXISTS events_site_day ON events (site, day);
CREATE INDEX IF NOT EXISTS events_view ON events (view_id);
CREATE INDEX IF NOT EXISTS events_visitor ON events (site, day, visitor);

-- Today's secret for the visitor hash. Yesterday's is deleted each night, so hashes can't be linked across days.
CREATE TABLE IF NOT EXISTS salts (
	day TEXT PRIMARY KEY,
	salt TEXT NOT NULL
);

-- The owner. A self-hosted ReaderCount has one account, signed in with ADMIN_PASSWORD.
CREATE TABLE IF NOT EXISTS accounts (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	plan TEXT NOT NULL DEFAULT 'self',
	trial_ends INTEGER,
	-- Email switches: Monday digest (off unless switched on), traffic spikes, monthly review, site down (on unless switched off).
	digest INTEGER NOT NULL DEFAULT 0,
	digest_sent TEXT,
	spikes INTEGER NOT NULL DEFAULT 1,
	monthly INTEGER NOT NULL DEFAULT 1,
	monthly_sent TEXT,
	downs INTEGER NOT NULL DEFAULT 1
);

-- The websites ReaderCount counts.
CREATE TABLE IF NOT EXISTS sites (
	domain TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	-- Public stats page (and whether it shows Google searches), and when the site's code was last found on its home page.
	public INTEGER NOT NULL DEFAULT 0,
	public_google INTEGER NOT NULL DEFAULT 0,
	verified_at INTEGER,
	-- Affiliate links tagged with the post they were clicked on (on unless switched off).
	tag_links INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS sites_account ON sites (account_id);

-- Signed-in browsers. Only a hash of the cookie is kept.
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	expires INTEGER NOT NULL
);

-- Wrong passwords, for slowing down guessing.
CREATE TABLE IF NOT EXISTS sign_in_fails (
	at INTEGER NOT NULL
);

-- Small settings, such as the address this ReaderCount answers on (for links in emails).
CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- OAuth for the Claude connector: registered apps (such as Claude), one-time codes, and tokens (hashed).
CREATE TABLE IF NOT EXISTS oauth_clients (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	redirect_uris TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
	code_hash TEXT PRIMARY KEY,
	client_id TEXT NOT NULL,
	account_id TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	challenge TEXT NOT NULL,
	expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
	token_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	client_id TEXT NOT NULL,
	account_id TEXT NOT NULL,
	expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_tokens_account ON oauth_tokens (account_id);

-- API keys (src/api.ts): read one website's stats from your own code. Only a hash of each key is kept.
CREATE TABLE IF NOT EXISTS api_keys (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	site TEXT NOT NULL,
	name TEXT NOT NULL,
	key_hash TEXT NOT NULL UNIQUE,
	hint TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used INTEGER,
	window_start INTEGER NOT NULL DEFAULT 0,
	window_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS api_keys_site ON api_keys (account_id, site);

-- Google Search Console (src/google.ts): the link (refresh token encrypted) and the searches copied each night.
CREATE TABLE IF NOT EXISTS google_links (
	owner TEXT PRIMARY KEY,
	token TEXT NOT NULL,
	connected_at INTEGER NOT NULL,
	synced_at INTEGER,
	last_error TEXT
);
CREATE TABLE IF NOT EXISTS search (
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	query TEXT NOT NULL,
	page TEXT NOT NULL,
	clicks INTEGER NOT NULL,
	impressions INTEGER NOT NULL,
	position REAL NOT NULL,
	PRIMARY KEY (site, day, query, page)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS search_days (
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	clicks INTEGER NOT NULL,
	impressions INTEGER NOT NULL,
	position REAL NOT NULL,
	PRIMARY KEY (site, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS search_sites (
	site TEXT PRIMARY KEY,
	property TEXT
) WITHOUT ROWID;

-- History brought in from Google Analytics (or another stats tool), and notes pinned to a day on the chart.
CREATE TABLE IF NOT EXISTS imported_days (
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	visitors INTEGER NOT NULL,
	views INTEGER NOT NULL,
	PRIMARY KEY (site, day)
);
CREATE TABLE IF NOT EXISTS notes (
	id INTEGER PRIMARY KEY,
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	text TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_site_day ON notes (site, day);

-- Hits left out because they looked fake, counted per website, day and reason (never the hits themselves).
CREATE TABLE IF NOT EXISTS filtered (
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	reason TEXT NOT NULL,
	n INTEGER NOT NULL DEFAULT 0,
	detail TEXT,
	PRIMARY KEY (site, day, reason)
);
-- Hits stored per website per day, for the per-website daily cap (src/filter.ts).
CREATE TABLE IF NOT EXISTS site_hits (
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	n INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (site, day)
);

-- Traffic spike alerts, broken link checks and site health.
CREATE TABLE IF NOT EXISTS spikes (
	site TEXT NOT NULL,
	path TEXT NOT NULL,
	day TEXT NOT NULL,
	visitors INTEGER NOT NULL,
	PRIMARY KEY (site, path, day)
);
CREATE TABLE IF NOT EXISTS link_checks (
	site TEXT NOT NULL,
	target TEXT NOT NULL,
	status INTEGER,
	checked_at INTEGER NOT NULL,
	fails INTEGER NOT NULL DEFAULT 0,
	broken_since INTEGER,
	alerted INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (site, target)
);
CREATE TABLE IF NOT EXISTS site_checks (
	site TEXT PRIMARY KEY,
	status INTEGER,
	checked_at INTEGER NOT NULL,
	fails INTEGER NOT NULL DEFAULT 0,
	down_since INTEGER,
	alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alert_sends (
	owner TEXT NOT NULL,
	day TEXT NOT NULL,
	n INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (owner, day)
);

-- What readers' browsers ran into, and forms they started.
CREATE TABLE IF NOT EXISTS problems (
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	path TEXT NOT NULL,
	kind TEXT NOT NULL,
	url TEXT NOT NULL,
	message TEXT NOT NULL DEFAULT '',
	browser TEXT NOT NULL DEFAULT '',
	n INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (site, day, path, kind, url, message, browser)
);
CREATE TABLE IF NOT EXISTS form_starts (
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	path TEXT NOT NULL,
	form TEXT NOT NULL,
	n INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (site, day, path, form)
);
CREATE TABLE IF NOT EXISTS report_use (
	owner TEXT NOT NULL,
	month TEXT NOT NULL,
	n INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (owner, month)
);

-- Triggers (src/triggers.ts): goals set up with no code, with optional emails and webhooks.
CREATE TABLE IF NOT EXISTS triggers (
	id INTEGER PRIMARY KEY,
	site TEXT NOT NULL,
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	pattern TEXT NOT NULL,
	notify TEXT NOT NULL DEFAULT 'none',
	webhook TEXT,
	created_at INTEGER NOT NULL,
	sent_day TEXT,
	sent_n INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS triggers_site ON triggers (site);

-- Ghost (src/ghost.ts): Admin API details (encrypted) and the posts' titles and dates.
CREATE TABLE IF NOT EXISTS ghost_links (
	site TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	api_url TEXT NOT NULL,
	key TEXT NOT NULL,
	hook_id TEXT,
	hook_hash TEXT UNIQUE,
	connected_at INTEGER NOT NULL,
	synced_at INTEGER,
	last_error TEXT
);
CREATE TABLE IF NOT EXISTS posts (
	site TEXT NOT NULL,
	path TEXT NOT NULL,
	title TEXT NOT NULL,
	day TEXT NOT NULL,
	PRIMARY KEY (site, path)
);
CREATE INDEX IF NOT EXISTS posts_day ON posts (site, day);

-- Earnings: uploaded reports, affiliate networks (tokens encrypted), AdSense, and earnings alerts.
CREATE TABLE IF NOT EXISTS earnings (
	site TEXT NOT NULL,
	day TEXT NOT NULL,
	shop TEXT NOT NULL,
	pence INTEGER NOT NULL,
	PRIMARY KEY (site, day, shop)
);
CREATE TABLE IF NOT EXISTS affiliate_links (
	site TEXT NOT NULL,
	network TEXT NOT NULL,
	account TEXT NOT NULL,
	token TEXT NOT NULL,
	connected_at INTEGER NOT NULL,
	synced_at INTEGER,
	last_error TEXT,
	PRIMARY KEY (site, network)
);
CREATE TABLE IF NOT EXISTS affiliate_earnings (
	site TEXT NOT NULL,
	network TEXT NOT NULL,
	day TEXT NOT NULL,
	shop TEXT NOT NULL,
	page TEXT NOT NULL DEFAULT '',
	pence INTEGER NOT NULL,
	PRIMARY KEY (site, network, day, shop, page)
);
CREATE TABLE IF NOT EXISTS money_alerts (
	site TEXT NOT NULL,
	kind TEXT NOT NULL,
	sent_at INTEGER NOT NULL,
	PRIMARY KEY (site, kind)
);
CREATE TABLE IF NOT EXISTS adsense_links (
	owner TEXT PRIMARY KEY,
	token TEXT NOT NULL,
	account TEXT,
	connected_at INTEGER NOT NULL,
	synced_at INTEGER,
	last_error TEXT
);
