# Abandoned cart recovery for Rawhide City Leather

**Status: everything built and wired; nothing sending yet.** The only thing left is
the three Brevo secrets — set those and it all goes live at once.

Done: Worker code written, tested and deployed; `RECOVERY` KV namespace created
(`be611b5493984061803449b43657eec4`); Brevo account authenticated for
`rawhidecityleather.com`; and the Snipcart campaign **"Standard recovery"**
(`2f52240e-d938-4662-ace5-5f93921732cc`) created Aug 18 2026 with both templates
loaded and verified.

Like `email/`'s other templates, the files in this folder stay in the repo and are never
deployed to the live site (`email/` is listed in `.assetsignore`).

**Steps 1 and 2 are Snipcart's. Step 3 is ours.** That split is the single most
important thing on this page, and it is a real trap: if step 3 is left configured in
the Snipcart campaign *and* the Worker cron is running, every customer gets two
last-call emails.

| Step | Fires | Sent by | Source |
|---|---|---|---|
| 1 | ~4 hours | Snipcart campaign | `abandoned-cart-1-reminder.html` |
| 2 | ~24 hours | Snipcart campaign | `abandoned-cart-2-help.html` |
| 3 | 72 hours | **our Worker, hourly cron** | `worker/recovery.js` |

Two step-3 templates also live in this folder. **Neither is wired to anything** now
that the Worker owns step 3 — they are kept as fallbacks if you ever want to go back to
a Snipcart-only setup:

- `abandoned-cart-3-lastcall.html` — no discount, the original
- `abandoned-cart-3-lastcall-15off.html` — one shared code, the design the Worker's
  email is built from

Edit the Worker, not these files, to change what customers actually receive.

## The discount, and the argument against it

Rob decided in Aug 2026 to run 15% off on step 3. Recording the counter-argument so
the decision gets re-made on purpose rather than by drift:

**A recovery coupon teaches the wrong habit.** This is a small niche where buyers talk
to each other. Train firefighters to abandon a cart and wait for a coupon, and they
will. What actually stalls a $165 custom radio strap is usually not price — it is a
buyer unsure they picked the right length, or one who hit the 6 week lead time and
hesitated. That is what step 2 answers, and step 2 stays discount-free for that reason.

So: **only step 3 carries money.** Steps 1 and 2 sell the work. If recovery revenue
climbs but full-price checkouts fall over the same stretch, that is the habit forming,
and the discount comes back off.

One flag worth checking on whatever you create: `combinable` defaults to **true** in
Snipcart, meaning the recovery code can stack on top of any other live discount. Set
it false unless you actually want stacking.

## Why step 3 is ours and not Snipcart's

Snipcart's discount expiry is **one absolute calendar date on the code**, shared by
everyone who receives it. A single code expiring Aug 24 gives someone who abandoned on
the 17th a full week and someone who abandoned on the 23rd a single day. There is no
per-recipient window, and no template token that would let us inject one.

The only way every customer gets the same seven days is a code minted per cart — which
means creating the discount ourselves through Snipcart's API, and therefore sending the
email ourselves. That is `worker/recovery.js`.

What it does, hourly:

1. Lists carts abandoned in the last week.
2. Keeps the ones past 72 hours it has not already emailed.
3. Mints a single-use code (`RCL` + 8 characters), 15%, expiring exactly 7 days out,
   `combinable: false` so it can never stack on a sitewide sale.
4. Sends the email through Brevo.
5. Writes a KV record so the next run leaves that cart alone.

**The guardrails, and why each exists** — all in `worker/recovery.js`:

| Guard | Value | Without it |
|---|---|---|
| `SEND_AFTER_HOURS` | 72 | — the 3 day mark itself |
| `MAX_AGE_HOURS` | 168 | the first run after deploy mails everyone who ever abandoned a cart |
| `MAX_PER_RUN` | 25 | a backlog goes out as one blast instead of trickling |
| `MAX_ATTEMPTS` | 3 | a permanently bad address is retried hourly forever |
| KV record | 90 days | the same person gets the same coupon every hour for a week |

The discount is created **before** the send and the code is stored immediately, so a
failed send retries with the *same* code rather than minting a second one. And nothing
is minted at all unless the mailer is fully configured — otherwise a misconfiguration
would leave live 15% codes in Snipcart that nobody was ever told about.

## Setting up the campaign

Snipcart dashboard, two separate places. Templates first, then the campaign.

### 1. Load the templates

**Account → Email settings → Abandoned carts → Edit.**

The editor is code on the left, live preview on the right. Paste one file in, press
**Ctrl+S** to refresh the preview, then **Save & Exit**.

The subject line is the `---` block at the very top of each file. Keep it. That is how
Snipcart reads the subject, and deleting it leaves the email with no subject. Note the
capital S in `Subject:` — that is what Snipcart's own default template uses, so the
templates here match it rather than risk a case-sensitive parser.

If Snipcart only exposes one abandoned-cart template rather than one per step, load
step 1 as the saved template and keep step 2 in this folder until you are ready to swap
it in. Check what the campaign editor offers before assuming. Step 3 is not affected
either way — the Worker builds its own email and never touches Snipcart's templates.

### 2. Build the recovery campaign — TWO steps only

**Manage store → Recovery campaigns → new campaign.**

- Name it something like `Standard recovery` (internal only, customers never see it).
- Leave the minimum order value empty so it matches every cart. Snipcart always
  matches a cart to the *most specific* campaign, so if you later add a high-value
  campaign it will take precedence on its own.
- Add **two** steps, with templates 1 and 2. **Snipcart's delays are fixed buckets** —
  15 min, 1 hour, 6 hours, 1 day, 2 days, 3 days, 1 week — so there is no 4 hour
  option. Step 1 uses **> 6 hours**, the closest to the 4 the template was written
  for; 1 hour reads as surveillance on a $165 considered purchase. Step 2 uses
  **> 1 day**. Snipcart only offers later buckets on later steps, so the ordering
  enforces itself.
- **Do not add a third step, and do not attach a discount to anything.** The Worker
  owns 72 hours. A third step here means two last-call emails per customer.
- Create no discount by hand either. Every recovery code is minted per cart by the
  Worker. Codes appear in **Manage store → Discounts** as they are issued, named
  `Cart recovery 15% - <customer email>`.

### 3. Turn on the Worker side

All in the site repo.

**a. KV namespace — DONE Aug 17 2026.** Created and already wired into
`wrangler.jsonc` as `be611b5493984061803449b43657eec4`. Nothing to do.

**b. Set the three secrets:**

```bash
npx wrangler secret put BREVO_KEY
npx wrangler secret put RECOVERY_FROM
npx wrangler secret put RECOVERY_POSTAL_ADDRESS
```

- `BREVO_KEY` — a Brevo API key (Brevo calls them "SMTP & API" keys). **Free to 300
  emails/day**, which is far above recovery volume. Why Brevo and not Cloudflare's
  no-API-key Email Sending, or SendGrid: see the header comment in `worker/mailer.js`.
  Short version — Cloudflare's terms exclude marketing mail, and SendGrid now costs
  $19.95/mo and is only worth it if you *also* want order confirmations fixed, which
  is a separate decision (`SENDGRID-SETUP.md`, still open).
- `RECOVERY_FROM` — must be on `rawhidecityleather.com`, the domain customers checked
  out on, and that domain must be authenticated in Brevo first. Sending from
  `rawhidecitylthr.com` recreates the exact from/storefront mismatch already suspected
  of putting tracking emails in the trash.
- `RECOVERY_POSTAL_ADDRESS` — a real mailing address for the footer. **A PO box is
  fine and the home shop address does not have to be published.** This is not optional
  decoration: the email's purpose is a discount offer, which makes it commercial mail
  under CAN-SPAM, and commercial mail must carry a physical address and a working
  opt-out. The Worker refuses to send until this is set.

**c. Deploy.** The hourly cron in `wrangler.jsonc` starts on the next deploy.

Until all three secrets exist, the cron runs, finds nothing it is allowed to do, logs
`skipped=mailer-not-configured`, and sends nothing. That is the intended safe default —
you can deploy this before the Brevo account exists, and it already is deployed.

### Brevo domain authentication — DONE 2026-08-17

`rawhidecityleather.com` is **Authenticated** in Brevo. Manual setup method, no branded
subdomain. These three records are live in Cloudflare and confirmed resolving against
1.1.1.1:

| Type | Name | Content | Proxy |
|---|---|---|---|
| TXT | `@` | `brevo-code:d7ee88359c66e1d3229858e29b7c0aef` | n/a |
| CNAME | `brevo1._domainkey` | `b1.rawhidecityleather-com.dkim.brevo.com` | DNS only, grey |
| CNAME | `brevo2._domainkey` | `b2.rawhidecityleather-com.dkim.brevo.com` | DNS only, grey |

Nothing here is secret — DNS is world-readable — so these live in the repo on purpose.

**Brevo's "Automatic" setup method was declined deliberately.** It connects Brevo to
Cloudflare with write access to the whole zone — MX, site DNS, everything — to add
three records. Manual was used instead. Don't switch without deciding that trade on
purpose.

**Grey cloud on both CNAMEs.** Proxying a mail record through Cloudflare breaks it;
this is the same trap as `pm-bounces` in the Postmark migration and the SendGrid
CNAMEs. Also watch Cloudflare doubling the hostname on paste: the name must read
`brevo1._domainkey`, not `brevo1._domainkey.rawhidecityleather.com`.

**Leave MX alone.** Cloudflare Email Routing handles all inbound mail for this domain
(`orders@`, `info@`, `rob@` forward into the business Gmail). Domain authentication is
outbound only and does not touch it.

### Brevo offers a fourth record. It was NOT added, on purpose.

Brevo's wizard also hands you a **DMARC** record for `_dmarc`, pointing `rua=` at
Brevo's own reporting address. **It was skipped.** This domain already has one:

```
v=DMARC1; p=none; rua=mailto:rawhidecityleather@gmail.com
```

Under RFC 7489, two TXT records at `_dmarc` means the policy is treated as **absent** —
adding Brevo's would have silently undone the Aug 10 2026 fix and blinded the `rua=`
reporting. **Brevo's own verification passed anyway**, marking the DMARC record as
matching, because it only checks that a valid DMARC record exists. So there is no cost
to skipping it and a real cost to adding it. Same applies to any future ESP that offers
a DMARC record: this zone has one, leave it alone.

**No SPF change either.** The apex is `v=spf1 include:_spf.mx.cloudflare.net ~all` and
Brevo did not ask for an include. Brevo aligns via DKIM using its own return-path, so
DMARC passes on DKIM alone. Don't add a Brevo SPF include unless Brevo explicitly asks.

**Do not ratchet `_dmarc` up.** It stays at `p=none`. Three services sign as this
domain, not the one these notes used to assume:

| Sender | Records | What it is |
|---|---|---|
| **Kit** (ex-ConvertKit) | `cka._domainkey`, `cka2._domainkey`, `ckespa` | The newsletter. Live and ours — the "Get on the List" form on 27 pages posts to Kit form `9729782`. Added 2026-07-26. |
| **Cloudflare** | `cf2024-1._domainkey` | Email Routing's own DKIM. |
| **Brevo** | `brevo1/2._domainkey` | Cart recovery, added 2026-08-17. |

Postmark is on the *other* zone, `rawhidecitylthr.com`, not this one.

Going to `p=quarantine` or `p=reject` before all three are authenticated and verified
silently kills the ones that are not.

### 4. Test it before it can reach anyone

```bash
node worker/tests/run.mjs recovery
```

49 checks covering the timing window, dedup, retry behaviour and the blast-radius caps.
Then, for a real end-to-end: add something to a cart on the live site, enter your own
email at checkout, close the tab, and wait out the 72 hours. `wrangler tail` shows each
run's counts.

### 5. Know what happens to the carts already sitting there

The two halves behave differently here, and the difference matters.

**Steps 1 and 2 (Snipcart):** carts abandoned *before* you create the campaign are never
matched. The first couple of days will look quiet even when everything is wired
correctly. Nothing to do about it.

**Step 3 (the Worker):** the opposite. It reads Snipcart's abandoned-cart API directly
and does not care when the campaign was created, so **any existing cart in the 72 hour
to 7 day window gets a coupon on the first cron run after deploy.** That is the backlog
handled for you — but it also means deploying is the moment real mail starts going out.
Look at **Manage store → Abandoned carts** and know what is in that window before you
deploy.

Carts older than 7 days are deliberately never touched. If you want to reach one of
those, it is a manual send from the dashboard.

Two addresses are skipped automatically, both in `TEST_EMAILS` in `worker/recovery.js`:
`test@example.com`, and **`rawhidecityleather@gmail.com`** — the shop's own inbox, which
really does appear in the live abandoned-cart list from checkout testing and would
otherwise be mailed a coupon and burn a minted discount.

Matching is case-insensitive, which matters because the dashboard renders addresses
uppercased.

**The catch:** an address on that list can no longer be used to test the real flow, since
the cron skips it. Test with a different inbox you own, and put nothing in `TEST_EMAILS`
that you still want to receive mail.

## Template variables (confirmed against Snipcart's docs)

**Steps 1 and 2 only.** The Worker's step 3 email is built in JavaScript from the cart
object and uses none of this.

Snipcart email templates use a port of Handlebars, plus custom helpers.

| Token | What it is |
|---|---|
| `{{settings.cartUrl}}` | Link that returns the customer to their cart. **The one token these emails cannot work without.** |
| `{{order.billingAddress.fullName}}` | Customer name |
| `{{order.email}}` | Customer email |
| `{{#has_any order.items}}` | Renders the block only when the cart has items |
| `{{#each order.items}}` | Loops the cart lines |
| `{{name}}` / `{{quantity}}` / `{{money totalPrice}}` | Inside the loop: line name, count, formatted price |
| `{{money order.summary.total}}` | Cart total, currency-formatted |

`{{money ...}}` is Snipcart's own helper and applies your account currency. Do not
hand-format prices with a dollar sign.

**If you run the store on more than one domain**, swap `{{settings.cartUrl}}` for
`{{settings.cartCreatedAtUrl}}`, which returns the buyer to the domain where the cart
was actually made. Right now Snipcart's default website domain is
rawhidecityleather.com and rawhidecitylthr.com 301s to it, so `cartUrl` is correct and
no change is needed.

## Testing steps 1 and 2

1. Load the templates. The editor previews with **dummy data**, so check layout there
   first: logo loads, button is visible, cart lines render.
2. Add something to a cart on the live site, enter an email at checkout to trigger the
   abandoned cart record, then close the tab without paying. Use a real inbox you own.
3. **Manage store → Abandoned carts**, find the cart, and send a manual email to
   yourself. That is the fastest way to see a real send without waiting 4 hours.
4. In the received email, confirm: the name filled in, the cart lines are right, prices
   are formatted, and the button actually returns you to a cart with the items still in
   it. The button is the whole ballgame.
5. Delete the test cart from the dashboard afterward so it does not sit in the list.

The same cart will get step 3 from the Worker 72 hours later, which is also the easiest
real test of the coupon: check that the code in the email actually applies at checkout,
takes 15% off, and stops working the second time you try it.

## A dashboard gotcha worth remembering

Claude can click in the Snipcart dashboard but **cannot type into it** — the permission
classifier blocks keystrokes on the live dashboard, and setting values through the
browser console does not persist in Snipcart's UI. So every field here has to be typed
by hand. Pasting the templates is the bulk of the work and there is no way around it.
