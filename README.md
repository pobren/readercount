<div align="center">
  <img src="docs/logo.svg" width="64" height="64" alt="">
  <h1>ReaderCount</h1>
  <p><strong>Private, cookie-free website stats that run on your own Cloudflare account.</strong><br>
  Free for personal and small business use, source available.</p>
  <p><a href="https://paulobrien.dev/readercount/">Website</a> · <a href="#install">Install</a> · <a href="https://github.com/pobren/readercount/releases">Releases</a> · <a href="https://github.com/pobren/readercount/issues">Report a bug</a> · <a href="https://github.com/pobren/readercount/discussions">Ask a question</a></p>
</div>

ReaderCount counts who reads your websites without cookies, without a consent banner and without sending anything to anyone else. It installs into your own Cloudflare account as one Worker and one D1 database, so the stats are yours and keep running on their own. Every feature is in. There's nothing to unlock.

- **The stats you need on one page:** visitors, views, top pages, sources, countries, devices, time on page and how far people scroll.
- **Goals:** sign-ups, enquiries and sales, with the pages and sources that bring them in.
- **Clicks on outgoing links and downloads**, including affiliate links, and **affiliate earnings** per post from Awin, Impact, CJ and others.
- **Google Search Console** searches next to your visits.
- **What to fix:** broken links, missing pictures, script errors, slow pages and 404s your readers hit.
- **Emails:** a Monday digest, traffic spikes, a monthly review and an alert when a website goes down.
- **Ask Claude about your stats** with the built-in connector, or read them from your own code with the API.
- **Public stats pages and a media kit** for the websites you choose.
- **Your own brand:** your name, logo, colour and support address instead of ReaderCount's.

## The licence in plain English

ReaderCount is free to use for **one person or organisation's own websites, up to 10 of them**. You can read the code, change it and run it on your own Cloudflare account.

You need a commercial licence to go over 10 websites, to run it for clients or to offer it to others as a hosted, managed or white-label service. That includes client mode below. [Get in touch about a commercial licence](https://paulobrien.dev/contact/) (choose "Work together").

There's no licence key and nothing in the code checks. Each version becomes Apache 2.0 four years after it's released. The full terms are in [LICENSE](LICENSE) (Business Source License 1.1), and they're what counts.

## What you need

- A Cloudflare account. The free plan is fine for most websites.
- A domain on that account if you'd like ReaderCount on your own address, such as stats.example.com. Your free workers.dev address works too.

## Install

There are three ways. All of them install into your own Cloudflare account, and updating later keeps your stats.

### 1. The installer (recommended)

You need [Node.js](https://nodejs.org) 22 or later.

```sh
npx @mrpwob/readercount setup
```

It signs you in to Cloudflare in your browser, makes the database, asks for a password and deploys ReaderCount. At the end it gives you your stats address. To update later, run `npx @mrpwob/readercount update` in the same folder.

### 2. Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pobren/readercount)

The button copies ReaderCount to your GitHub account, makes its database in your Cloudflare account and deploys it. It asks for one thing:

- **ADMIN_PASSWORD:** the password you'll sign in with. Use at least 12 characters, and replace the example: it won't work.

To update later, pull the latest code into your GitHub copy (GitHub's **Sync fork**) and Cloudflare deploys it again.

### 3. From the code

```sh
git clone https://github.com/pobren/readercount.git
cd readercount
npm install
npx wrangler login
npx wrangler d1 create readercount        # copy the database_id it prints into wrangler.jsonc
npx wrangler secret put ADMIN_PASSWORD    # at least 12 characters
npm run deploy
```

`npm test` runs the tests, and `npm run dev` runs it on your computer (put a password in `.dev.vars` first, as in `.dev.vars.example`).

## Start counting

1. Open your ReaderCount address and sign in with your password.
2. Add your website.
3. Copy the line it shows you into every page of your website, just before `</head>`:

```html
<script defer src="https://YOUR-STATS-ADDRESS/s.js" data-site="example.com"></script>
```

Visits show within a minute. The **Check** button on your stats page tells you if the line is in place.

To stop counting your own visits, open any page of your website once with `#readercount-ignore` on the end of the address. `#readercount-count` undoes it.

**Your own address.** Ad blockers block some workers.dev addresses, so stats on your own domain count more readers. In the Cloudflare dashboard open **Workers & Pages**, then **readercount**, then **Settings** and **Domains & Routes**, and add a custom domain such as stats.example.com.

## Goals

Add `data-rc-goal="Name"` to any button, link or form, and ReaderCount counts it as a goal with that name:

```html
<button data-rc-goal="Newsletter sign-up">Sign up</button>
```

Every form sent is counted too. From your own code, call `readercount("Name")`. Plausible's `plausible("Name")` and `plausible-event-name=` classes count as well, so a website moving from Plausible keeps its events.

## Emails

Emails are off until you set them up, because they're sent from your own domain:

1. Switch on **Email Routing** (or Email Sending) for your domain in Cloudflare.
2. In `wrangler.jsonc`, add `"send_email": [{ "name": "EMAIL" }]` and set `OWNER_EMAIL` (where emails go) and `MAIL_FROM` (an address on your domain) under `vars`.
3. Deploy again.

Then choose which emails you'd like under **Emails** on your stats page: the Monday digest, traffic spikes, the monthly review and website down alerts.

## Google Search Console

See the Google searches that bring readers in, next to your visits:

1. In [Google Cloud](https://console.cloud.google.com/apis/credentials), make an OAuth client of the type **Web application**, with `https://YOUR-STATS-ADDRESS/google/callback` as its redirect address. Switch on the **Google Search Console API** for the project.
2. Add its details as secrets: `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
3. Press **Continue with Google** on your stats page.

ReaderCount only reads from Google, and keeps its Google sign-in encrypted. To encrypt with your own key rather than one made from your password, add a `GOOGLE_TOKEN_KEY` secret.

## Ask Claude about your stats

ReaderCount has a Claude connector built in. In Claude, open **Settings**, then **Connectors**, then **Add custom connector**, and paste `https://YOUR-STATS-ADDRESS/mcp`. Claude asks you to sign in to ReaderCount once, then you can ask things like "which posts brought in the most readers from Google last month?". Claude can only read your stats, and **Disconnect** on your stats page signs it out.

## API

Make a key under **API** on your stats page. Each key reads one website and can't change anything. Send it in a header:

```sh
curl -H "Authorization: Bearer rc_..." "https://YOUR-STATS-ADDRESS/api/v1/overview?period=7d"
```

| Address | What it gives |
| --- | --- |
| `GET /api/v1/overview` | Headline stats, top pages, sources and clicks (`period`) |
| `GET /api/v1/breakdown` | Views or clicks grouped by one thing (`by`, `of`, `period` or `from` and `to`, filters) |
| `GET /api/v1/google-searches` | Google Search Console figures, when connected |
| `GET /api/v1/check` | Whether the website's visits are arriving |

Keep keys on your server, never in a web page.

## Your own brand

Under **Branding** on your stats page, set your own name, logo, colour and support address. They replace ReaderCount's on every page and email. Leave a box empty to keep ReaderCount's.

## Client mode

Client mode lets an agency or host offer ReaderCount to their own clients, under their own brand, with their own plans and prices. It's off until you switch it on under **Clients** (on your stats page). **Running ReaderCount for clients needs a commercial licence:** [get in touch](https://paulobrien.dev/contact/) first.

- **Clients sign in with a one-time link.** With emails set up, they ask for one on the sign-in page. Without, press **Make a sign-in link** and send it yourself.
- **Each client sees only their own websites.** They can't see yours, each other's or your settings.
- **Plans are yours:** a name, how many websites and the price wording your clients see.
- **Payments go straight to your own Stripe account.** Make each plan's product and price in Stripe, paste its Price ID into the plan, then add two secrets: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. In Stripe, add a webhook to `https://YOUR-STATS-ADDRESS/billing/webhook` for `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`. Stripe sends the receipts, and clients change their card or cancel on Stripe's own page.
- **Clients who pay you another way:** mark them **Free** and they keep their plan without Stripe.

A client whose subscription stops sees the plans page until they pick one, and their websites stop being counted.

## Robot check (optional)

The sign-in page can use [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/), Cloudflare's free check that a person is using the form. Most people see nothing; a few are asked to tick a box. Wrong passwords are already limited, so this is an extra layer.

1. In Cloudflare, open **Turnstile** and add a widget. Use your ReaderCount address as its hostname and choose **Managed**.
2. On the Worker, open **Settings › Variables and Secrets** and add two secrets: `TURNSTILE_SITE_KEY` (the site key) and `TURNSTILE_SECRET` (the secret key). Add both as secrets, so updates keep them.

It switches on once both are there. Remove either one to switch it off.

## Privacy

ReaderCount sets no cookies and stores nothing in your readers' browsers. A visitor is counted once a day with a code made from a daily secret, so nobody can be followed from one day to the next. It never records what anyone typed, where they clicked or their IP address. Everything stays in your own Cloudflare account. Set `RETENTION_DAYS` in `wrangler.jsonc` to delete visits after that many days.

## Help

- Questions: [Discussions](https://github.com/pobren/readercount/discussions)
- Bugs: [Issues](https://github.com/pobren/readercount/issues)
- New versions: [Releases](https://github.com/pobren/readercount/releases), or [paulobrien.dev/readercount](https://paulobrien.dev/readercount/)

## Licence

[Business Source License 1.1](LICENSE). Free for one person or organisation's own websites, up to 10. Each version becomes Apache 2.0 four years after its release.
