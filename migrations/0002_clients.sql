-- Client mode (src/clients.ts): sell ReaderCount to your own clients, with your own plans and your own Stripe account.
-- Off until you switch it on under Clients. Running ReaderCount for clients needs a commercial licence (see LICENSE).

-- Each client is an account. plan is a client_plans id; status is 'free' (you let them in without paying),
-- 'active' (paying through Stripe), 'unpaid' (no plan yet, or payment stopped).
ALTER TABLE accounts ADD COLUMN client_plan INTEGER;
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'free';
ALTER TABLE accounts ADD COLUMN name TEXT;
ALTER TABLE accounts ADD COLUMN stripe_customer TEXT;
ALTER TABLE accounts ADD COLUMN stripe_subscription TEXT;
ALTER TABLE accounts ADD COLUMN paid_until INTEGER;

-- The plans you offer: a name, how many websites, the words clients see about the price, and the Stripe Price ID
-- to charge (made in your own Stripe dashboard). No price ID means you switch clients on by hand.
CREATE TABLE IF NOT EXISTS client_plans (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	sites INTEGER NOT NULL,
	price_label TEXT NOT NULL DEFAULT '',
	stripe_price TEXT,
	created_at INTEGER NOT NULL
);

-- One-time sign-in links for clients (only a hash is kept), emailed or copied by you.
CREATE TABLE IF NOT EXISTS sign_in_links (
	token_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	expires INTEGER NOT NULL
);
