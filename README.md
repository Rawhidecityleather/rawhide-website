# Rawhide City Leather Website

Static site. No build step. Just HTML, CSS, JS.

## File structure

```
rawhide-website/
├── index.html              Homepage
├── shop.html               All products
├── product-*.html          7 product pages
├── about.html              Brand story
├── contact.html            Contact
├── shipping.html           Shipping & returns
└── assets/
    ├── css/style.css       All styles
    ├── js/main.js          Mobile nav + year
    └── img/
        ├── logo.png        Your badge logo
        ├── hero.jpg        Hero background (fire scene)
        ├── story.jpg       Story section image
        └── products/
            ├── fully-custom-radio-strap.jpg
            ├── custom-radio-strap.jpg
            ├── basic-radio-strap.jpg
            ├── basket-weave-belt.jpg
            ├── helmet-band.jpg
            ├── helmet-morale-cards.jpg
            └── glove-strap.jpg
```

## Adding your images

**For product photos, use the dashboard instead** — *Product photos and wording* below.
Adding one there needs no deploy, makes both sizes for you, and updates the
seven places a product photo appears. What follows is the fallback set that
ships in the repo, and what a product falls back to when nothing is uploaded.

Drop these into `assets/img/` with the exact filenames:

| File | What it is |
|---|---|
| `logo.png` | Your Rawhide City Leather badge logo (transparent PNG, square or wide) |
| `hero.jpg` | The fire scene photo (truck, firefighter, smoke) |
| `story.jpg` | The red radio pouch on engine, or any atmospheric shot |
| `products/fully-custom-radio-strap.jpg` | Pooley/Thorne/Phillips chair shot |
| `products/custom-radio-strap.jpg` | Brauneker brown strap + radio holder |
| `products/basic-radio-strap.jpg` | Black/orange-stitched strap on door |
| `products/basket-weave-belt.jpg` | Black basket weave belt with ruler |
| `products/helmet-band.jpg` | BERNING red helmet on diamond plate |
| `products/helmet-morale-cards.jpg` | Hansen black/red name patch |
| `products/glove-strap.jpg` | Isolated glove strap on white paper |

**Image specs:** JPG, ~1500px wide. Anything larger works but slower. Square aspect for products is ideal.

## Editing content

Each page is plain HTML. Open in Notepad or VS Code, find the text, change it, save.

- **Prices**: search for `$150.00` (or any price) and edit
- **Product descriptions**: in each `product-*.html`, look for `<div class="product-description">`
- **Hero title/tagline**: in `index.html`, look for `<h1 class="hero-title">`
- **Product photos and descriptions**: not here — *Product photos and wording* below, on the dashboard

## Google tag setup

Analytics and Ads conversion tracking are wired up in `assets/js/main.js`, but
they stay switched off until you paste your IDs. Open that file — the three
values are the first thing in it:

```js
var GA4_ID='';
var ADS_ID='';
var ADS_LABEL='';
```

Anything left empty stays off, so a half-filled config never sends junk data.

### Getting GA4_ID (Google Analytics)

1. Go to **analytics.google.com** → sign in with your business Google account
2. **Admin** (bottom left) → **Create** → **Property**
3. Name it `Rawhide City Leather`, set timezone to Eastern, currency USD
4. Pick **Web** as the platform, enter `rawhidecityleather.com`
5. It shows you a **Measurement ID** that looks like `G-ABC1234XYZ`
6. Paste it between the quotes on the `GA4_ID` line

### Getting ADS_ID and ADS_LABEL (Google Ads)

Only needed when you actually start running Google Ads.

1. Go to **ads.google.com** → create an account if you don't have one
2. **Goals** → **Conversions** → **New conversion action** → **Website**
3. Enter `rawhidecityleather.com`, then **Add a conversion action manually**
4. Category **Purchase**, value **Use different values for each conversion**,
   count **Every**
5. After saving, click **Tag setup** → **Install the tag yourself**
6. You'll see two values in the snippet:
   - `AW-123456789` → this is your `ADS_ID`
   - In the line `'send_to': 'AW-123456789/AbC-D_efGhIjKlM'`, the part *after*
     the slash is your `ADS_LABEL`
7. Paste both in. Ignore the rest of the snippet Google shows — the site
   already has the wiring, it just needs the IDs.

### What gets tracked

Once the IDs are in, both Google and Meta receive the full funnel:

| Buyer action | Google Analytics | Google Ads | Meta |
|---|---|---|---|
| Views a product | `view_item` | — | `ViewContent` |
| Adds to cart | `add_to_cart` | — | `AddToCart` |
| Starts checkout | `begin_checkout` | — | `InitiateCheckout` |
| Completes order | `purchase` | `conversion` | `Purchase` |

Purchase value is Snipcart's actual charged total, so any discount is already
taken out — the numbers in your ad dashboards match real revenue.

### Testing it

1. Paste the IDs, deploy
2. In Google Analytics: **Admin** → **DebugView**, then browse your own site —
   events should appear within a few seconds
3. Place a real $6.40 leather butter order to confirm `purchase` fires with the
   right value, then refund yourself

## Custom build inquiry form

The contact page's inquiry form posts to **`POST /api/inquiry`** on the Worker,
which emails the whole thing to `rawhidecityleather@gmail.com`. Reply-to is set
to the customer, so hitting reply in Gmail answers them directly.

It needs the three Brevo secrets above. With those unset the endpoint returns
503 and the page falls back to opening the visitor's mail client with everything
they typed already in the body — so nothing is lost either way, it is just
worse: it needs them to have a working mail client and to press send themselves.

**History worth knowing.** This form used to post into a Kit form, and shipped
between 2026-07-26 and 2026-08-18 with a literal unreplaced `KIT_FORM_ID`
placeholder in the action. The mailto fallback above is what carried it through
that window. It was moved off Kit rather than repaired because a Kit form
endpoint is a *newsletter subscription* endpoint: it would have subscribed
everyone who wrote in about an order, and buried the details of a custom build
in a subscriber record instead of putting it in the inbox where it gets
answered.

The newsletter signup — a different form, on 27 pages — is still Kit, still
form `9729782`, and was never affected.

### Spam handling

The form carries an off-screen honeypot field named `company`. Anything that
fills it gets a 200 and no email, so a bot has nothing to tune against. Body
size is capped and every field is truncated. If real spam ever gets through,
Turnstile is the next step up.

### Known limit

No file uploads, so the form asks people to email sketches and photos
separately. If custom builds pick up and chasing photos by email gets old, that
is the upgrade — the artwork uploader on the product pages already proves the
pattern.

## Order dashboard

Live at **rawhidecityleather.com/dashboard**. Same login as the packing slip.
It reads every order out of Snipcart and gives you three things: what you've
made, what still has to ship, and a way to get tracking numbers back in without
touching Snipcart's dashboard.

Bookmark it. It's `noindex` and behind a password, so nobody finds it on their
own.

### The numbers

| Tile | What it counts |
|---|---|
| Net revenue | Paid orders in the window, minus anything refunded |
| Orders | Paid orders in the window |
| Average order | Net revenue ÷ paid orders |
| Awaiting shipment | Paid, not cancelled, not shipped yet — all time, not just the window |
| Lifetime revenue | Every paid order since day one, minus refunds |

Cancelled and unpaid orders never count toward revenue. The four buttons up top
switch the window; the trend arrows compare against the same stretch of the
previous period, so "this month" on the 4th is measured against the first 4 days
of last month, not against the tail end of it.

### Shipping through Pirate Ship

Pirate Ship has no API, and it takes nothing in a URL, so no link can hand it an
order. Labels are always bought on their site. What the dashboard does is carry
the order over, two ways.

**One order — Buy label**

Hit **Buy label** on the order's row in **Ship queue**. That copies the address
and opens Pirate Ship's single-label screen in a new tab. Press **Ctrl+V** there
(**Cmd+V** on a Mac) — their paste field opens on its own and fills the whole
Ship To block. Check it, weigh the package, buy the label.

**Leave the customer's email on the label.** That is the only reason tracking
comes back here by itself — see below. The pasted block already carries it.

If the browser blocks the clipboard, the dashboard says so and the address is
still on the row to copy by hand.

**A batch — the spreadsheet**

1. In **Ship queue**, check the orders you're shipping
2. **Download Pirate Ship CSV**
3. **Open Pirate Ship** → upload that file on their spreadsheet screen
4. First upload only: tell Pirate Ship which column is which (field mapping)
5. Buy the labels

The CSV carries name, address, phone, email, order number, contents, a box size
and a weight.

**The weights are estimates, not scale readings.** They're at the top of
`worker/pirateship.js`:

```js
const ITEM_OUNCES = {
  'fully-custom-radio-strap': 14,
  'basic-radio-strap': 11,
  ...
};
const PACKAGING_OUNCES = 3;   // mailer, tissue, card — added once per order
```

Weigh a few real packages and fix these numbers. They lean heavy on purpose —
overpaying a few cents beats a postage-due package coming back at you.

### Getting tracking numbers back in

Three ways, and all of them do the same three things: save the tracking number,
flip the order to **Shipped**. None of them email anybody.

**Snipcart does not send a tracking email on its own.** It offers to, but only
when you set the tracking number by hand in Snipcart's own order screen, which
pops up a prompt. Everything here writes through the REST API instead, so that
prompt never happens. The customer's tracking email comes from Pirate Ship.

That matters for a package that goes out **without** a Pirate Ship label — handed
over at the station, a counter label at the post office, a replacement sent at our
own cost. Nothing has told the customer. For those, tick **email the customer** on
that order's row before hitting Ship, and the Worker sends it: the same design
Pirate Ship uses, so the two are indistinguishable.

The tick is **off by default**, and that is deliberate. The common case is a Pirate
Ship label, which already mailed the customer an hour after it was bought — ticking
it there would be the duplicate notification this whole setup avoids.

It needs the same Brevo secrets the cart recovery uses (`BREVO_KEY`, `RECOVERY_FROM`,
`RECOVERY_POSTAL_ADDRESS`). If they are missing the order still ships and the
dashboard says the email did not send, rather than pretending it did.

- **By itself** — Pirate Ship BCCs its tracking email here and the order ships
  on its own. Nothing to type. Setup is below.
- **One order** — type the tracking number in its row in the ship queue, hit
  **Ship**.
- **A whole batch** — paste Pirate Ship's shipment list into **Add tracking in
  bulk**. Order number and tracking number per line is all it needs; header rows
  and extra columns are ignored. Anything it can't match to an order gets
  reported back instead of guessed at.

USPS and UPS numbers are told apart automatically, so the tracking link in the
customer's email goes to the right carrier.

#### Tracking that files itself (one time)

Pirate Ship emails the customer a tracking number an hour after a label is
bought, and that email can be BCC'd. Point the BCC at the Worker and every label
reports itself back — no paste, no spreadsheet.

It reads the customer's address off the BCC'd copy and matches it to their
order, so **a label bought without the customer's email reports nothing**. The
**Buy label** button puts the email in the pasted block for exactly this reason.

Pick an address on the domain with something unguessable in it, the same way the
receipts address is built — `tracking-<random>@rawhidecityleather.com`. **It is a
secret, not a line in `wrangler.jsonc`**: this repo is public, and anything
printed here is an address strangers can mail.

In this order — the routing rule bounces mail if the Worker isn't ready for it:

1. **Set it and deploy.**

   ```
   npx wrangler secret put TRACKING_INBOX
   npx wrangler deploy
   ```

2. **Cloudflare** → Email → Email Routing → Routing rules → **Create address**
   for that same address, action **Send to a Worker**, pick this Worker.

3. **Pirate Ship** → Settings → Tracking Emails → **Edit Template** → put it in
   the **BCC** field → save.

Leave `TRACKING_INBOX` unset and the feature is simply off — mail to the Worker
all goes down the receipts path, exactly as before.

Three things have to hold before anything ships: the message has to be addressed
to that inbox, it has to pass SPF/DKIM/DMARC **as pirateship.com** — a forged
`From:` gets nowhere — and it has to name an address with an open order.
Everything else is forwarded to the shop inbox and left alone. Repeat mail from
the carrier's own scans is ignored, since the number is already on the order.

**The customer gets two emails this way**: Pirate Ship's, and Snipcart's when
the order flips to Shipped. Turn one off — either raise Pirate Ship's *Default
Email Delay* out of the way under Settings → Tracking Emails, or switch off
Snipcart's shipping notification. Pirate Ship's has to keep sending, or nothing
gets BCC'd and the whole loop stops.

If a tracking email can't be matched, it lands in the shop inbox and the paste
box in the dashboard is still there. Nothing is lost, it just needs a hand.

### Register the webhook (one time)

This is what makes "tracking number added → Shipped" happen even when the
tracking gets added somewhere else, like Snipcart's own dashboard.

1. Log into **app.snipcart.com** → **Store Configurations** → **Webhooks**
2. Put this in the URL field:
   ```
   https://rawhidecityleather.com/dashboard/hooks/snipcart
   ```

That's the whole setup. **There is no per-event subscription** — Snipcart has
one URL field and sends every event to it. So the handler in `worker/index.js`
gets called for everything and picks out the two it cares about:

| Event | What it does |
|---|---|
| `order.trackingNumber.changed` | flips the order to Shipped, so the status matches reality even when the tracking number was added in Snipcart's own dashboard |
| `order.completed` | closes a quote link the moment it's paid |

Everything else gets a polite `{"ok":true,"ignored":"…"}` and nothing happens.
Adding a new event means adding a branch there, not changing anything in
Snipcart.

Without the webhook the dashboard still works — the Ship button and the bulk
paste set the status themselves, and the dashboard decides a quote is paid by
matching real orders rather than trusting the stored flag. A quote link would
just stay live until it expires.

The same page keeps a history of every hook sent, with the request and the
response side by side, and a **Send this hook again** button for replaying one
against a change without waiting for a real order.

## Quotes for crew and station orders

Live at **/dashboard#quotes**. This is how you bill a crew for a job that isn't
in the catalog — twelve memorial straps, a promotion set, a retirement piece.

You build the quote, they get a link, they pay through the normal checkout. The
order lands like any other, so the ship queue, packing slip, Pirate Ship export
and tracking all work with nothing extra to do.

Or they hand you cash. Set the quote to **cash or check** and there's no
checkout at all — you print the invoice, they pay at the bench, and you mark it
paid. See [Cash jobs](#cash-jobs) below.

### One-time setup

Quotes are stored in a Cloudflare KV namespace. Create it once:

```bash
npx wrangler kv namespace create QUOTES
```

Paste the id it prints into `wrangler.jsonc` where it says
`PASTE_KV_NAMESPACE_ID_HERE`, then deploy. Until that's done the Quotes card
shows up empty and creating one gives you an error saying exactly this.

### Sending one

1. **Dashboard → Quotes**, fill in what it is, who it's for, and the lines
2. Leave **How they pay** on **Card**
3. **Create quote**, then **Copy** the link and send it to them
4. They open it, hit **Accept & Pay**, and it becomes a normal order

Links expire on the schedule you pick — 30 days by default. **Void** kills one
early if you got a price wrong. A quote that's been paid can't be voided.

**Print** on any row gives you the sheet on paper — the lines, the total, and
the pay link written out. Handy for handing a quote over at a station rather
than emailing it.

The link is public and unguessable. It has to be public: before Snipcart takes
the money it fetches the quote page to check the price against the cart, and it
can't get past a login prompt. Treat the link like a payment link — anyone who
has it can pay it, and nobody who doesn't can find it.

### Cash jobs

Pick **Cash or check** under *How they pay* and the quote stops being a payment
link. Nothing goes to Snipcart, so there is no order, no packing slip and no
tracking email behind it — **the printed sheet is the record. Keep a copy.**

1. Build it the same way, set *How they pay* to **Cash or check**
2. Fill in **Sales tax** if the job is taxable — see below
3. **Create quote**, then **Print invoice**
4. Hand it over, take the money, write the sign-off block at the bottom
5. Back on the dashboard, **Mark paid** on that row, and say cash or check

The sheet reprints as a **receipt** once it's marked paid, so the customer's
copy and your copy are the same document at two points in its life. The crew's
online link still works — it shows what they owe and says to pay in person.

**Sales tax is on you.** On a card quote Snipcart works the tax out from the
address it collects. A cash sale never reaches checkout, so whatever percent
you type in is what prints on the invoice and what you collect — and if you
leave it blank, no tax is charged. Tick **Tax exempt** instead when the
department has a certificate on file; the exemption then prints on the face of
the invoice the same way it does on a packing slip.

Because a cash job has no order behind it, **Mark paid** is the only thing that
closes it out. Leave it and the quote sits open until it expires on work that
was paid for weeks ago.

Once it's marked paid the job shows up at the bottom of the **Ship queue** and
under **All orders**, next to the Snipcart orders, so paid work can't hide in
the Quotes table. It has no address and no tracking number, so its button is
**Mark handed over** — that takes it off the queue and flips it to done in the
order list. A card quote needs none of this: it's already in both as its order.

A paid cash job also counts as revenue, dated the day it was marked paid, for
the full amount collected — tax included, the same way a Snipcart order counts
its grand total. It's in the revenue tiles, the order count, the monthly chart
and Top products (under the quote's title). Because that KV record is the only
book of record for the money, a paid cash quote is stored with no expiry.

## Custom stamp artwork

The fully custom radio strap sells custom stamps as a paid option — one for $15,
two for $25 — and each one needs the customer's artwork.

Snipcart has six custom-field types and none of them is a file, so the artwork
can't ride along in the cart. The product page uploads the file to the Worker
first, gets a URL back, and puts that URL in an ordinary readonly custom field.
The order carries the link; the bytes live in R2. The link prints on the packing
slip, clickable.

### One-time setup

```bash
npx wrangler r2 bucket create rawhide-logo-uploads
```

The `LOGOS` binding in `wrangler.jsonc` already points at that name. Until the
bucket exists, uploads fail with a message saying so, and the customer is told
to email the file instead — the order still goes through.

### What it accepts

PNG, JPG, WEBP, GIF, HEIC and PDF, up to 8 MB. The type is decided by reading
the file's first bytes, not by trusting its extension — a `.png` that's really
an HTML page is refused.

**SVG is deliberately not accepted.** It's XML that can carry script, and these
files are served back from our own origin, so an SVG would be a stored XSS on
the packing slip. Don't add it back.

### Where the files live

Nothing is public. `/logo/<key>` sits behind the same login as the dashboard and
the packing slip, so once you're logged in the link on a slip just opens. The
keys are random, so they can't be guessed or walked from one order to the next.

Files are never deleted automatically. If the bucket ever needs trimming, an R2
lifecycle rule is the way — but at this order volume it will be years.

To remove one file by hand:

```bash
npx wrangler r2 object delete "rawhide-logo-uploads/<key>.png" --remote
```

**`--remote` is not optional.** Without it wrangler deletes from the local
simulated bucket, prints "Delete complete", and leaves the real object exactly
where it was.

### If the money ever changes

The stamp prices live in **two** places on
`product-fully-custom-radio-strap.html`: the visible `<select>` and the hidden
`snipcart-add-item` button Snipcart re-fetches to price the order. Both have to
change together or the cart charges something the page never offered. There's a
test that fails if they drift — `node worker/tests/run.mjs uploads`.

### Crew pricing on hats and patches

The tier copy is in the repo. **The discount itself is not** — it's a Snipcart
dashboard rule keyed to the product id, and nothing here can see it. Change one
without the other and the site advertises a number the cart never takes off.

Patch hats (`leather-patch-hat`), $25 each:

| Quantity | Off  | Each   |
| -------- | ---- | ------ |
| 5+       | 10%  | $22.50 |
| 10+      | 15%  | $21.25 |
| 20+      | 20%  | $20.00 |

Velcro patches (`velcro-patch`), $7 each: 10 or more, 10% off.

The copy lives on `product-leather-patch-hat.html`, `crews.html`, `shop.html`
and `hats.html`. Grep for `or more hats` to find every one of them.

### Sitewide discounts and quote pricing

A storewide automatic percentage reaches quotes. Snipcart's automatic
discounts can only be pointed *at* products, never away from them, so a quote
can't sit outside the sale. Under a 20% rule, a $1,800 quote goes out with
$2,250 on the button, Snipcart takes its 20%, and the crew pays $1,800. The
quote page shows both numbers.

**This follows the sale banner on its own.** A new quote reads the running
sale (`quoteDiscountRate` in `worker/promo.js`) and grosses up by it; when
the sale ends, new quotes go back to face value. Only an *automatic, percent,
whole store* sale does this — a code, a dollar amount, or a sale on named
products leaves quotes alone. `CHECKOUT_DISCOUNT` in `worker/quote.js` is
now just the fallback the tests use; leave it at 0.

Outstanding quotes are the reason expiry matters. A link created under a sale
carries the grossed-up price for as long as it lives, so before switching a sale
off, check **Quotes** for anything still open and void what you don't want paid
at the old arithmetic.

### Tax-exempt departments

Most departments and districts are exempt from sales tax, but the exemption is
only good if you're holding the paperwork. Get their certificate first — in
Florida that's a **Consumer's Certificate of Exemption (Form DR-14)** — then
tick **Tax exempt** and record the entity, the certificate number, and the date
it runs out.

What that does:

- the checkout charges **no sales tax** on that order
- the quote page shows the entity and certificate number on its face, so their
  purchasing office has it on what they print
- the packing slip prints a **Sales tax exempt** block with the same details
- the dashboard puts a **Cert** flag on any quote whose certificate has expired,
  or expires before the quote does

Keep the certificate itself somewhere you can find it — the dashboard records
the number, not the document, and the document is what an auditor asks for. If a
department's certificate lapses, their next quote is taxable until they send a
current one. Worth running past your accountant once so you know what you're
keeping and for how long.

### Secrets

The first three are already set if the packing slip works. To rotate one:

```bash
npx wrangler secret put SNIPCART_SECRET
```

| Secret | What it's for |
|---|---|
| `SNIPCART_SECRET` | Snipcart **secret** API key. Reads orders, writes tracking and status. Never sent to the browser. |
| `SLIP_USER` | Dashboard username |
| `SLIP_PASS` | Dashboard password |
| `BREVO_KEY` | Outbound email. Brevo API key — free to 300/day. Why Brevo: header comment in `worker/mailer.js`. |
| `RECOVERY_FROM` | From address for outbound email. Must be on the Brevo-authenticated `rawhidecityleather.com`. |
| `RECOVERY_POSTAL_ADDRESS` | Mailing address printed in the cart-recovery footer. Required by CAN-SPAM; a PO box is fine. |

If `SLIP_USER` or `SLIP_PASS` is missing, the dashboard locks everyone out
rather than opening up.

Those three now power **two** things: the cart-recovery cron and the contact
form at `POST /api/inquiry`. They are all-or-nothing. With any unset the cron
sends nothing and logs `skipped=mailer-not-configured`, and the inquiry endpoint
returns 503 so the contact page falls back to handing the inquiry to the
visitor's mail client — which is exactly what it did before the endpoint
existed. Safe to deploy before the Brevo key is set.

### Cron

One trigger, hourly, defined in `wrangler.jsonc`: abandoned cart recovery. It
mints a single-use 15% code per cart at the 24-hour mark and emails it, which is
the only thing in this repo that contacts customers unprompted. How it works and
what the guardrails are: `email/ABANDONED-CART-SETUP.md`.

It stores one record per emailed cart in the `RECOVERY` KV namespace, created
Aug 17 2026 and already wired into `wrangler.jsonc`. That record is what stops
the hourly cron mailing the same person every hour for a week — if you ever
recreate the namespace, every cart in the window looks new again.

**It holds its fire while the whole store is on sale.** Before minting anything
the run asks Snipcart what a buyer already gets for doing nothing, and if an
automatic storewide percentage is at least as good as the coupon's 15%, it sends
nothing and logs `skipped=store-wide-15-percent-already-on`. Both rules are
non-combinable, so a coupon sent underneath a sale is not an offer — the buyer
types the code and swaps 15% for an identical 15%.

That is not a precaution, it is a post-mortem. The Labor Day rule ran
automatically from Sep 3 2026, and every recovery code minted underneath it went
unused while the automatic rule itself was redeemed again and again. Nothing is
written to KV when a run is held back, so every one of those carts still gets a
real coupon on the first run after the sale comes down.

Only a rule that a buyer genuinely already has counts: no code to type, a
percentage rather than dollars off, applying to the whole order rather than to
named products, live and unexpired, and with no order minimum a small cart would
miss. If Snipcart cannot be reached the run sends anyway — a failed read must not
quietly stop recovery for good.

### Whether any of it is working

**Cart recovery** on the dashboard, or the `#recovery` card on `/dashboard`.
Four numbers and a table, so this stops being a thing you find out by opening
Snipcart and counting:

| Tile | Where it comes from |
|---|---|
| Coupons sent | the `RECOVERY` KV log, which is what the cron itself writes |
| Used | Snipcart's own usage count on each minted code |
| Carts waiting | the live abandoned-cart list, inside the 7-day window |
| Sitting in them | those carts added up |

Under them is **what the carts are full of**, counted by cart rather than by
line. That tally is the point of the card. The most useful thing anyone has
learned about these carts is that fifteen of twenty-four held the same $165
six-week-lead strap — a fact about the product page, not about the coupon — and
it took a hand count to see once.

**There is deliberately no "revenue recovered" tile.** Snipcart's discount object
says a code was used but not what the order came to, and a dollar figure
assembled from a guess about the order payload would be the one number on the
page nobody could check. When a code does get used, the order shows up in the
orders table like any other.

A tile whose source could not be read shows a dash and says so, rather than a
zero. The whole gather is wrapped so a Snipcart outage costs the card its
numbers and not the dashboard its page.

Each row links to the cart it belongs to. **That link restores the customer's
own cart**, their stamping and their address on it — the same reason a cart
token never goes in this repo. Treat it like their address.

**Send it now** on a row does by hand what the hourly run does on its own: mints
that buyer a single-use 15% code and emails it. It is for a cart that has not
reached 24 hours yet, or one you have just been talking to somebody about — the
age window lives in the run loop, not in the send itself, so a cart two hours old
can still be reached.

Every guard that protects the automatic run protects this one too. A cart that
has had a coupon has no button. A buyer who had one this week on another cart is
refused, and the row says which rule stopped it rather than just failing. Nothing
is minted before the mailer is checked, so a refusal never leaves a live 15% code
in Snipcart that nobody was told about.

While the store is on sale the button asks first, because that is the one case
where pressing it spends a real coupon on a discount the buyer already has. It is
still allowed — there are reasons to reach somebody anyway.

## The sale banner and its Snipcart rule

The strip across the top of every page — "Handmade in Lakeland, FL · Firefighter
Owned · Free Shipping $85 and up" — can be swapped for a sale line from the
dashboard, and the matching discount created in Snipcart, without a deploy.
**Sale banner** on the dashboard: type the headline, pick the deal (percent or
dollars off, the whole store or named products), say whether it is automatic
or a code, pick the dates, tick **Show it on the site**, save.

Two things then happen from that one form:

- The Worker swaps the bar on every page while the sale is live and puts the
  stock line back when the end date passes. The cart repeats a code beside the
  Discounts line so nobody has to scroll back up for it.
- A discount rule is created in Snipcart to match — the same percent or amount,
  the same products, the same code — and archived again when the sale ends or
  is switched off. A sale with a start date goes up on that date: the hourly
  cron pushes the rule, so it can be up to an hour late on the rule and a
  minute late on the bar.

The card shows both halves: the banner's state, and what Snipcart actually has
(fetched live, with the usage count). If Snipcart refuses the rule the banner
still saves, the Snipcart line on the card says what it said, and the hourly
run keeps trying. Pick **Banner only** to run a sale whose rule you set up in
Snipcart by hand — free shipping, a buy-one-get-one, anything the form does
not offer.

Dates are calendar days in Florida: a sale that ends Sep 8 is up through the
last minute of Sep 8 Eastern. The rule also carries that as its Snipcart
expiry, as a backstop for the day the cron does not fire. Leave both dates
blank and it is on until you switch it off.

The bar always says which kind of sale it is — "No code needed" or "Use code X
at checkout" — because of Labor Day 2026: the rule was automatic, every ad
said "code LABORDAY15", the promo box rejected the code, and buyers who
already had the 15% left thinking the sale was not for them. The rule and the
banner now come from one record, so they cannot disagree.

**Quotes follow it.** A storewide automatic percent grosses up new quotes on
its own — see *Sitewide discounts and quote pricing* above.

**The rule is non-combinable**, like the cart-recovery coupon, so the two never
stack. A buyer holding a recovery code during a storewide sale gets whichever
one they apply, not both. That is also why **cart recovery stops sending while
an automatic storewide percentage is live** — see *Cron* above. Run a sale and
the coupons pause on their own; end it and they resume on the next hour.

**How it finds its own rule.** Every rule it makes is named `Sale banner: …`.
Before creating one it lists Snipcart's discounts and reuses any active rule
with that prefix, archiving extras, so a stale read or a double save never
leaves two live rules taking two cuts. Do not rename those rules in Snipcart;
edit the sale here instead.

### One-time setup

Done 2026-09-13. Kept here for the day it has to be rebuilt:

```bash
npx wrangler kv namespace create PROMO
```

Put the id under `kv_namespaces` in `wrangler.jsonc` as binding `PROMO` and
deploy. Without the binding the card explains itself and nothing else changes —
pages pass through untouched.

### Where it lives

One JSON record, key `current`, in the `PROMO` namespace. `worker/promo.js`
is the banner: the record's shape, the date window, the card, the rewrite.
`worker/promo-sync.js` is the Snipcart side: the rule body and the hourly
reconcile. `GET /api/promo` is public and says only what the bar already says
(never the dates); the cart script in `assets/js/main.js` reads it.

Adding a product to the repo means adding it to `PRODUCTS` in `worker/promo.js`
too, or the picker cannot point a sale at it. A product added on the dashboard
instead is in the picker on its own, as soon as it is on the site.

## Product photos, wording and options

**Products** on the dashboard, or `/dashboard/products`. Open a product, change
its photos, its words or the choices on its order form, save. No deploy, no
resizing, no editing seven files by hand.

### The wording

Four boxes, and every one of them opens filled in with what the site says right
now — so changing one sentence means changing one sentence, not retyping five.

| Box | Where it shows |
|---|---|
| On the page | the paragraphs under the price |
| The bullets | the spec list under those, where the lead time lives |
| Search summary | the line under the title in Google, and the link preview when somebody shares it |
| Google Shopping | the description in the Merchant feed, longer and more literal |

**Anything you leave exactly as it is keeps coming out of the repo.** On save,
a box that still matches `product-<id>.html` word for word is not stored at
all. That is deliberate: a field you did not touch still follows along if the
page is edited in the repo later, and only what you actually changed is pinned.
It also means pressing Save on a product you did not edit does nothing at all.

**The wording box is plain text, not HTML.** A blank line starts a new
paragraph. `**Two stars**` makes the same highlight the repo's own pages use.
Nothing else is markup, and anything else you type is shown as you typed it.

**Use the built-in wording** puts all four boxes back to the repo's text.

### Two things it will flag

These are rules the shop set, so the editor flags them as you type and the save
says so again. Neither one blocks the save — it is your copy — but both were
learned the expensive way.

- **"Hand-stitched" and anything like it.** The stitching is done on an
  industrial walking-foot machine, and the shop's own videos show it running.
  Hand-stamped and hand-cut are both still true and still in voice.
- **"Lakeland" and "firefighter owned".** Provenance stays off product wording;
  the announcement bar, the footer and the About page carry it instead. It had
  to be pulled back out of eight pages and the feed once already.

On the three patch hats there is a third: **hand-cut** and **engraved by hand**
are flagged there, because the patch is laser cut and engraved, then
heat-pressed. Nothing on a hat is cut or finished by hand, and crisp repeatable
crests are the actual selling point on a crew order of ten.

### The photos

One photo appears in seven places on this site, and a photo changed here
changes all seven:

| Where | What it gets |
|---|---|
| The product page gallery | every photo, in the order you set |
| The card in the shop grid | the first one |
| The link preview (`og:image`) | the first one |
| The structured data Google reads | the first one |
| The cart thumbnail | the first one |
| The Google Shopping feed | the first as the main image, the rest as extras |
| The `<img>` width and height | the real size, so the page doesn't jump |

**The first photo is the main one.** Move a photo to the front of the row and
it becomes the big one on the page, the card in the grid, and the picture that
shows when somebody shares the link.

**A product either uses your photos or the repo's, never a mix.** Upload one
photo and that is the whole gallery — the built-in ones stop showing. So upload
the full set you want the page to have. **Use the built-in photos** puts it
back and deletes the ones you uploaded.

**Photos straight off a phone are fine**, up to 12 MB each. JPG, PNG, WEBP, GIF
and HEIC all work. Cloudflare Images makes the full-size WebP and the thumbnail
on the way in; there is nothing to resize first.

**Say what is in the photo.** The box under each one is the description read out
to anyone who cannot see the image, and read by Google. Leave it blank and it
falls back to the product name, which is never wrong and never useful.

### The options

The dropdowns on the order form: leather colours, stitch colours, hardware
finishes, hat colours, strap lengths. One box per dropdown, one choice per
line, in the order the customer sees them.

```
Black
Brown
Chestnut
```

**An upcharge goes on the end of the line.** `White +10.00` adds ten dollars
when that colour is picked. The price sits next to the colour it belongs to on
purpose — adding a stitch colour to the radio bucket without its ten dollars
should take a deliberate omission, not a forgotten step.

**Out of stock without deleting it.** Two dashes and a reason greys a choice
out and leaves it on the list saying why:

```
Black
Chestnut
Brown -- out of stock
```

The customer can see it exists and can't pick it, and Snipcart won't take it
either. That is how the radio bucket carries brown while there are no photos
of it. Delete the line instead and the colour simply vanishes, which tells a
customer nothing.

**Headings**, for a list long enough to need them. `## Richardson 112` starts
one. Only the hat colours use them today — twenty-six colours across two
blanks, and ungrouped it is a list people pick the wrong thing from.

**Where the list starts** depends on how the page was built, and it stays that
way. A dropdown that makes the customer choose keeps its "Select…" row; one
with a plain "No preference" row keeps that and keeps it pickable. A dropdown
with neither starts on whatever is now the first line, which is also how you
change the default: move it to the top. An out-of-stock line is skipped over
for that — the dropdown never opens on something nobody can buy.

**Use the built-in options** puts every dropdown on that product back to what
the repo says.

A priced list lands in two places and both have to agree: the dropdown itself,
and Snipcart's own copy on the hidden buy button, which its crawler reads to
check the price the cart was handed. Rewrite one and not the other and the
order is refused at checkout. Both are written here, and the button's field is
found by **name** rather than by the number it happens to sit at — a stored
number would be silently wrong the day a field moved in the HTML, and the
upcharge would land on somebody else's option.

An unpriced list matters too. `Waterproof|Richardson 112` costs nothing either
way, and it is what makes Snipcart show the field as a dropdown in the cart and
check the value came off it. Four fields on the hats are exactly that, so a
list the page declared keeps its declaration even if every price comes off.

### What options will NOT do

**It does not change the shape of a form.** Fields are not added, removed,
renamed or retyped here. That is still the HTML, because a field is wired to
Snipcart by name and to the packing slip by its label.

**The two "Custom Stamps" dropdowns are left alone**, on the fully custom and
Smokey straps. They are shown on the page with a note saying why. That field
decides how many artwork upload slots appear by reading the number off the
front of the chosen value, so renaming `1 custom stamp` would take the fifteen
dollars and then never ask for the file. Change that one in the HTML.

**Removing a choice somebody already has in a cart** will fail their checkout,
the same as changing a price in the repo would. Rare, and worth knowing before
you cut a colour on a busy afternoon.

### What to watch for

**Google reads the words printed in a photo**, as well as the ones you type. A
worksheet, a price list, a brand name on a can — any of it can get the product
disapproved in Merchant Center. That is exactly what happened to the glove
strap: a "HOLSTER BLUE PRINTS" sheet was sitting in the frame.

**Changing a photo or the Shopping description sends that product back to Google
for review.** A Shopping listing can go quiet for a day or two after a swap.

**Changes take up to a minute** to reach every page, the same as the sale banner
and for the same reason: KV caches a record for 60 seconds at each location.

### Where it lives

Five files, split by what they do rather than by what they are called:

| File | What's in it |
|---|---|
| `worker/catalog.js` | the record, the KV read, the feed, and the one pass of HTMLRewriter |
| `worker/photos.js` | the photo machinery: upload, both sizes, the gallery markup |
| `worker/product-copy.js` | the wording: the fields, reading the repo's copy, the checks |
| `worker/product-options.js` | the dropdowns, and the two places a price has to land |
| `worker/products-page.js` | the dashboard page and the save |

The three working files are pure — hand them a product's photos, words or
choices and they hand back markup and a list of rules. `catalog.js` does the
lookups and the one rewrite. That split is what lets each of them be tested
without a parser or a binding.

One JSON record, key `catalog`, in the `CATALOG` namespace, holding every
product's photos, wording and dropdowns. The image bytes are in the
`rawhide-product-photos` R2 bucket, two objects per photo (`<id>-m.webp` full
size, `<id>-t.webp` thumbnail), served at `/photo/<key>`.

`/photo/<key>` is **public**, unlike `/logo/` and `/receipt/`. These are
storefront images — a shopper has to load them, and Google has to crawl them
for the feed. They are cached for a year and never overwritten: a changed photo
gets a new id, so the old URL can keep its promise.

The list of products comes from `PRODUCTS` in `worker/promo.js`, the same list
the sale picker uses. A new product has to be added there, and its page has to
be `product-<that id>.html`, or it will not appear here.

That is the products in the repo. A product added on the dashboard is not one
of them — it gets its own row at the top of the page and is edited there, name
and price included. See **Adding a product** below.

Photos are deleted from the bucket when you remove them and save. A photo
uploaded and never saved stays in the bucket, costing a fraction of a cent and
visible to nobody.

**One page has copy this does not touch.** The helmet band carries a second
block of long-form guide copy further down — "Leather or rubber?", the
questions. Only the first wording block on a page is edited here; that one
stays in the HTML.

### One-time setup

Done 2026-09-14. Kept here for the day it has to be rebuilt:

```bash
npx wrangler kv namespace create CATALOG
npx wrangler r2 bucket create rawhide-product-photos
```

Put the namespace id under `kv_namespaces` in `wrangler.jsonc` as binding
`CATALOG`, add the bucket as binding `PHOTOS`, and deploy. Without either
binding the page explains itself and nothing else changes — every product page
serves exactly what is in the repo.

### If it ever has to come out

Delete the `catalog` key from the `CATALOG` namespace and every product goes
back to its built-in photos, wording and options on the next request. Nothing in the
repo is touched by any of this — `product-<id>.html` and
`assets/img/products/` are the fallback, always.

## Adding a product

**Add a product**, at the top of the dashboard's Products page. A name, a price,
which part of the shop it goes in, photos, wording, and as many dropdowns as the
order form needs. Press Save and there is a product.

Everything above this section edits a product that is already in the repo. This
one builds a product that is not: there is no `product-<id>.html` anywhere, and
the Worker puts the page together on every request out of one record in KV.

### What pressing Save does

| Where | What lands there |
|---|---|
| `/product-<address>` | the whole page — gallery, price, order form, buy button, structured data |
| The shop grid | a card in the section you picked |
| `/hats` or `/radio-straps` | the same card, for those two categories only |
| `sitemap.xml` | the address, with the day it last changed |
| The Google Shopping feed | an item, if the box is ticked |
| The sale picker | a checkbox, so a sale can name it |

It reaches the site within a minute, the same as everything else here and for the
same reason: KV caches a record for 60 seconds at each location.

### Add it as a draft first

Leave **Put it on the site** off and save. The page answers, so you can open it
and read it, and it carries a `noindex` tag so Google leaves it alone. There is
no card in the grid and no item in the feed until you tick it.

That is the only way to see what the dropdowns and the wording actually look
like, and it costs nothing. A listing that goes up half-written is a listing
somebody can buy off.

### The address never changes

It is made from the name — `Shop Apron` becomes `/product-shop-apron` — and you
can edit it right up until you save. After that it is fixed, and the box is
read-only.

That is deliberate. The address is the Snipcart product id, and it is written
into every order ever placed for the thing. Rename it and those orders point at a
product that no longer exists.

### The order form

One box per dropdown, one choice per line, in the order the customer sees them.
The syntax is the same as the options editor above:

```
Black
Chestnut
Brown -- out of stock
```

**An upcharge goes on the end of the line.** `White +10.00` adds ten dollars when
that colour is picked, and the card in the grid then says "From $95.00" instead
of "$95.00".

**Two dashes and a reason** greys a choice out and leaves it on the list saying
why. `## Richardson 112` starts a heading.

**A dropdown nobody has to answer opens on its first line.** There is no blank
row on one, ever, and that is not a style choice. The cart script numbers the
custom fields on the hidden buy button by the fields that came back filled in,
and Snipcart's crawler reads the numbering off the page as it was served. A
dropdown that could arrive empty would shift every field after it by one, and the
upcharge would land on somebody else's option. So put the do-nothing choice at
the top and name it — `No stitching`, not a blank.

The **notes box** is the one field allowed to come back empty, which is why it is
always last.

### What it will not do

**No artwork upload.** The two "Custom Stamps" dropdowns on the fully custom and
Smokey straps drive how many upload slots appear, by reading a number off the
front of the chosen value. That wiring lives in the HTML and is not something to
copy here. A product that needs a customer's file needs a page in the repo.

**No Add to Cart on the card.** A card only gets one where the product has
nothing to pick first, and anything added here is assumed to have something.

**Only two category pages.** `/hats` and `/radio-straps` get the card as well as
`/shop`. Belts and accessories have no page of their own — `/shop#belts` is where
the footer sends people — so those land on the shop page only.

**It does not write to the repo.** Nothing here touches a file. Deleting the
`catalog` key from KV takes every added product off the site at once, and the
fourteen in the repo carry on exactly as they are.

### Deleting one

The page stops answering, the card comes off the grid, the feed entry and the
sitemap line go with it, and the photographs are deleted out of the bucket. It
cannot be undone.

Orders already placed are untouched. They live at Snipcart and carry their own
copy of what was bought.

### Where it lives

| File | What's in it |
|---|---|
| `worker/custom-product.js` | the record, the page, the card, the feed item, the sitemap line |
| `worker/custom-product-page.js` | the form on the dashboard, and the two writes behind it |

`worker/custom-product.js` is pure, the same as the three files above it — hand it
a product and it hands back markup. `worker/catalog.js` does the serving.

The products sit in the same `catalog` record as everything else, under `custom`
rather than `products`, so a page reads the lot in one call. Photos go in the same
`rawhide-product-photos` bucket and are served from the same public `/photo/<key>`.

**The page is built by rewriting a real one.** `/product-leather-butter` is
fetched out of the repo and its own product is replaced wholesale — the gallery,
the price, the form, the buy button, both structured data blocks, every meta tag.
What is left of it is the chrome: the header, the nav, the fonts, the footer, the
pixel, the cart script. Taking those from a real page is the point. Writing them
out in the Worker instead would mean maintaining the site's header twice, and the
copy nobody looks at would be the one that went stale.

Leather Butter is the donor because it is the plainest page in the repo: one
product, no upload slots, no crew pricing panel, exactly the two `ld+json` blocks
every product page carries. `worker/tests/custom-product.test.mjs` reads it off
disk and checks a built page against it, so the day that page changes shape the
test says so rather than the site.

**It needs HTMLRewriter**, which means it needs the Workers runtime. In the Node
preview an added product 404s instead of serving the donor — the wrong product at
the right address is worse than no page.

## A one-off coupon for one person

**One-off coupon** on the dashboard. Somebody emails, something needs putting
right, and they should get a code. Type who it is for, pick a percent or a
dollar amount and how many days it lasts, press the button. You get a code.

**It does not email anybody.** It mints the code, shows it, and stops. Copy it
and send it in your own words.

The label is only ever seen by you — it is what tells two codes apart in a list
a month later, so "Mike, cart missed the Labor Day 15" beats "discount 3". It
goes into the Snipcart discount name, which is private to the account.

Every code works **once**, on any cart, until it expires. Like every other rule
this repo writes it is **non-combinable**, so if a storewide sale is running
whoever uses it gets the better of the two, not both.

There is no new storage. Snipcart is the record: every code made here is named
`One-off: <label>`, which is how the card finds them again and where the used /
expired state comes from. The same trick the sale banner uses on its own rule.
`worker/coupon.js` is all of it.

**The reason this exists.** On 2026-09-13 a customer's cart missed the Labor Day
15% because the rule had been re-saved underneath him, and the only fix
available was talking him through clearing and rebuilding his cart. A code would
have taken one click.

## Receipts and the year-end expense report

`/dashboard/expenses` — photograph a receipt, it gets read, filed and totalled,
and in January one page prints to PDF for the accountant.

Each receipt is one row. The photo goes to R2, the row goes to KV, and a vision
model reads the vendor, date, total and sales tax off the picture so the row
arrives mostly filled in. **Nothing it reads is trusted.** Every row lands
unchecked, in a tinted colour, and stays that way until you tick *Check* — which
the page refuses to let you do until the row has a date, a vendor and an amount.
The report says out loud how many are still unchecked, on the page you'd be
handing over.

### One-time setup

Already done — both were created on 2026-08-18 and their ids are in
`wrangler.jsonc`. Recorded here for the day it has to be rebuilt:

```bash
npx wrangler kv namespace create EXPENSES
npx wrangler r2 bucket create rawhide-receipts
```

The `AI` binding needs nothing created. Without it — or if the model is down,
or the file is a PDF — the upload still stores and the row comes back blank to
type in. That is the designed fallback, not a failure.

### What it accepts

PNG, JPG, WEBP, GIF, HEIC and PDF, up to 10 MB, same first-bytes type check as
the artwork uploads and the same reason SVG isn't on the list.

There are two ways in. A **photo** goes to the vision model as an image. A
**PDF** has its text layer pulled out with `AI.toMarkdown()` and is read as
text — the ad platforms, hosting and software all invoice that way, and reading
the real text beats reading a picture of it. A scanned PDF has no text layer, so
nothing comes back; photograph that page instead and it goes down the image path,
which does work.

**HEIC is converted to JPEG on the way in**, by the `IMAGES` binding, before
anything is stored. iPhones shoot HEIC by default and it is unusable three ways
over — the model can't decode it, and no browser but Safari will draw it, so the
thumbnail and the image in the printed packet would both come out broken. The
JPEG is what lands in the bucket; there is no second copy. The phone's filename
is kept, the extension records what's actually stored. Scaled down to 2000px on
the long edge, which is far more than a receipt needs and keeps the file under
the reader's size limit.

If Images isn't enabled on the account, or a conversion fails, the HEIC is
stored as-is and the row comes back blank to type in — the receipt is never
refused. Conversions are billed per transformation and only ever run on a HEIC.

Receipts are private the same way artwork is: `/receipt/<key>` sits behind the
dashboard login, and the keys are random.

### Receipts by email

Half the shop's spending never arrives on paper to photograph. The ad platforms,
the tanneries, the software and the marketplaces all email an invoice, so there
is a second way in: **forward it to the shop's private filing address and it
becomes a row.** Cloudflare Email Routing already holds MX for the domain, so
that one address points at this Worker's `email` handler instead of forwarding
to Gmail. Every other address on the domain still forwards to the inbox as
before. See `worker/email-in.js`.

What happens to one message:

1. **It is forwarded to the shop inbox, whatever else goes right or wrong.**
   Nothing in here is ever the only copy of a receipt.
2. The sender is checked against `RECEIPT_SENDERS`. Anything else is forwarded
   and dropped — this address writes rows into the shop's books.
3. Real attachments — a PDF invoice, a photographed receipt — are stored and
   read down the same path as an upload. One row each, up to five per message.
4. With no attachment worth filing, **the body is the receipt**: it is stored as
   HTML so the original is still on file, and read as text.

Rows land unchecked exactly like uploads. A model reading a marketplace's HTML
table is a suggestion, never a number in the year-end report.

Two things the reader can't know are filled in from the message itself: with no
vendor read, the sender's name or domain, and with no date read, the day the
message was sent.

**The date fallback only applies to a receipt that arrived under its own steam.**
Not to an attachment — the date is printed on the document — and not to anything
that looks forwarded, meaning a `Fw:`/`Fwd:` subject or a forwarded-message
separator in the body. The first real receipt through this was a LightBurn order
from May, forwarded on in May, forwarded again to the filing address in August,
and it filed under August. Now that date is left blank instead. An undated row
sorts to the top of the ledger and stays there until somebody fills it in, which
is the point: a blank waiting to be filled beats a wrong date that looks
finished.

An emailed body shows an `EMAIL` badge in the ledger where a photo would show a
thumbnail; the printed packet lists those rows alongside the PDFs rather than
leaving holes in a page. Clicking either opens the original.

#### Setting up the address

The inbound address is **not** in `wrangler.jsonc` — there is no wrangler
setting for it. It is a routing rule, made once in the dashboard:

1. Cloudflare → the `rawhidecityleather.com` zone → **Email** → **Email
   Routing** → **Routing rules**.
2. **Create address**, something private — anyone who learns it and gets past
   the allowlist is writing into the books.
3. Action: **Send to a Worker** → `quiet-firefly-3711`.

Then the two vars in `wrangler.jsonc`, both plain rather than secrets (they are
addresses already printed on the live site):

- `RECEIPT_SENDERS` — who may file. Comma-separated; a bare `@domain.com` entry
  allows a whole domain, which is how a vendor gets to bill the address directly
  instead of being forwarded by hand. **Empty means nobody** — an unset list
  fails closed rather than filing whatever arrives.
- `RECEIPT_FORWARD_TO` — where every message is forwarded. Must be a verified
  Email Routing destination address.

The From header is a claim anyone can write, so the allowlist alone is not the
check: Email Routing verifies SPF, DKIM and DMARC at the edge, and the handler
reads the verdict out of `Authentication-Results`. A message that fails all
three is forwarded and dropped. A message carrying no such header is let
through — the address is private, the row lands unchecked, and failing closed on
a header that isn't there would mean the feature silently files nothing.

#### What it won't do

- **Nothing over 25 MB**, Email Routing's own ceiling — past that the message
  was truncated on the way in and its last attachment is half a file. Forwarded,
  not filed.
- **Nothing small.** Under 6 KB an attachment is a letterhead, a social icon or
  a tracking pixel, not a receipt. An inline image has to clear 40 KB before it
  outranks a real attachment.
- **Nothing it can't identify.** Same first-bytes check as everything else, so a
  vendor labelling its invoice `application/octet-stream` still files, and a
  `.pdf` that isn't one never gets stored as one.
- **It never bounces.** A crash inside the handler would return the message to
  whoever sent it, so every failure in here is a log line and a forwarded copy
  instead.

The MIME parsing is hand-written (`worker/mime.js`) rather than an npm package,
to keep this repo's no-dependency, no-install-step property — `node
worker/tests/run.mjs` is still the entire setup. The parse surface is small:
walk the part tree, decode base64 and quoted-printable, hand back the text and
the attachments. `worker/tests/mime.test.mjs` carries the weight a package's own
test suite would have, built out of real message shapes — a Gmail forward with a
PDF attached, a message forwarded *as* an attachment, an HTML-only receipt,
folded headers, encoded subjects.

### The buckets

Fourteen of them — leather, hardware, tools, shipping, packaging, advertising,
software, fees, shop supplies, vehicle, travel, meals, dues, and *Other — ask
the CPA*. They are the shop's own buckets, picked because they match how the
money actually leaves. **They are not tax categories.** Which Schedule C line
each one belongs on is the accountant's call, and the report says so on its
face. To add one, edit `CATEGORIES` in `worker/expenses.js`; the `match` pattern
beside each is only used to guess from a vendor name when the model doesn't name
one, so a rough pattern is fine.

### What the accountant gets

Two things, both off the year's chip at the top of the page:

- **CPA report** — a printable page: totals by bucket with each one's share,
  totals by month, then every receipt line by line. Print to PDF from the
  browser and send it. `With receipt images` appends the photos themselves, so
  the summary and the proof travel as one file — you have to be logged in for
  those to load, which you are.
- **CSV** — the same rows for a spreadsheet. Vendor names starting with `=`,
  `+`, `-` or `@` are prefixed with an apostrophe, because Excel treats those as
  formulas and this file gets opened on somebody else's machine.

**The report is spending only.** It carries no sales figure and is not a profit
and loss. An earlier version put the year's revenue on it, read from Snipcart —
it cost a walk of the whole order history to draw one row, and it tied the one
document with a deadline on it to the store API being up and the key being
current. Sales come off the store's own reports. Don't wire it back.

Nothing here is tax advice, and the page doesn't pretend otherwise. It gets the
receipts in one place with the totals already done.

### Undated receipts

A receipt with no date belongs to no year, so it would vanish from every year
page — which is the one thing that must never happen to a receipt nobody has
finished. They ride along with whatever year you're looking at, sort to the top,
and are counted separately so they can't be mistaken for filed spending.

### Deleting one

The `×` on a row drops the record and its photo together. There's no undo. To
remove a stray file by hand:

```bash
npx wrangler r2 object delete "rawhide-receipts/<key>.jpg" --remote
```

`--remote` is not optional here either — see the artwork section above.

## Tests

**Run these before deploying anything in `worker/`.**

```bash
node worker/tests/run.mjs
```

No install, no dependencies, no test framework — plain Node. It exits non-zero
on failure, so it works as a gate. To run one suite:

```bash
node worker/tests/run.mjs slip
```

| Suite | Covers |
|---|---|
| `quote` | pricing and the gross-up, validation, tax exemption, certificate warnings, status, the page Snipcart's crawler reads, cash jobs and their tax, the printable invoice and receipt, HTML escaping |
| `slip` | packing slip rendering with and without a quote attached |
| `expenses` | the ledger: categories, edits and what blocks checking a row off, KV round-trip, year and undated handling, totals, the CSV including Excel formula injection, both pages' HTML escaping, and every way reading a receipt can fail |
| `mime` | the hand-written email parser: folded headers, encoded subjects and filenames, base64 and quoted-printable, nested and prefix-clashing boundaries, a message forwarded as an attachment, HTML flattened to text |
| `email-in` | receipts by email: who may file and every way a message is refused, picking the real attachment out of the letterhead, the fallbacks from sender and subject, and the promises that must hold on a bad day — always forwarded, never bounced, an unreadable receipt still becomes a row |
| `worker` | routes through the real fetch handler — auth, the quote API, the public quote page, voiding, the printable sheet, marking a cash job paid, the webhook |

`worker` swaps in a KV shim and a stub asset router, so it needs neither
Cloudflare nor a Snipcart key. Anything that calls Snipcart directly — the
dashboard, the packing-slip route — can't be reached that way, which is why
`slip` drives `renderSlip` from a fixture instead. **If you touch a render
function, add a fixture case.** On 2026-08-06 a one-word slip change went out
untested and broke every packing slip in production; `renderSlip` and
`renderQuotePage` are exported specifically so that's a two-line test, and
`renderQuoteSheet` is exported for the same reason.

What the suites can't tell you: whether Snipcart accepts a real quote order.
That's a live checkout, and nothing here mocks it.

## Deploying

The site runs on **Cloudflare Workers**, not Netlify. One command puts
everything live — the pages, the images, and the Worker behind the dashboard:

```bash
npx wrangler deploy
```

That's the whole process. Changed a price, swapped a photo, edited the Worker —
same command either way. It takes about ten seconds and only uploads the files
that actually changed.

**If you touched anything in `worker/`, run the tests first** and only deploy if
they pass. In Git Bash:

```bash
node worker/tests/run.mjs && npx wrangler deploy
```

PowerShell has no `&&`, so there it's:

```powershell
node worker/tests/run.mjs; if ($?) { npx wrangler deploy }
```

### Pushing to GitHub does not deploy

There's no CI here. `git push` backs the code up; `wrangler deploy` puts it
live. They're separate, and either can be ahead of the other. If a change isn't
showing up on the site, this is almost always why.

### What's already set up

Done once, and not worth touching again:

| Piece | Where it lives |
|---|---|
| Worker | `quiet-firefly-3711` on the `rawhidecityleather@gmail.com` account |
| Domain | `rawhidecityleather.com`, attached in the Cloudflare dashboard under the Worker's **Settings → Domains & Routes** — deliberately *not* in `wrangler.jsonc`, so deploying can't disturb it |
| Static files | served straight from this folder by the `ASSETS` binding |
| `run_worker_first` | in `wrangler.jsonc` — the paths the Worker answers instead of the file router (`/dashboard*`, `/packing-slip*`, `/quote*`, `/logo/*`, `/photo/*`, `/api/*`) |
| Secrets | `wrangler secret put NAME` — see the table above |
| Quote storage | the `QUOTES` KV namespace |
| Artwork storage | the `LOGOS` R2 bucket (`rawhide-logo-uploads`) |
| Product photos and wording | the `CATALOG` KV namespace and the `PHOTOS` R2 bucket (`rawhide-product-photos`) |
| Products added on the dashboard | the same two — under `custom` in the `catalog` record, and the same bucket |

If wrangler ever asks you to log in:

```bash
npx wrangler login
```

### Undoing a bad deploy

```bash
npx wrangler versions list
npx wrangler rollback <version-id>
```

Every deploy keeps its predecessors, so going back is seconds rather than a
rebuild. Grab the id of the last good one from the list.

### Watching it run

```bash
npx wrangler tail
```

Live log of every request hitting the Worker — status, timing, and any
exception with its stack. This is the fastest way to find out what a failing
dashboard or webhook is actually doing.
