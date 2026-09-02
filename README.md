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

**No sitewide discount is running.** `CHECKOUT_DISCOUNT` at the top of
`worker/quote.js` is `0`, so the price on the button is the quoted price.

If you start another automatic discount, that constant has to move with it.
Snipcart's automatic discounts can only be pointed *at* products, never away
from them, so a quote can't sit outside the sale. Under a 20% rule, a $1,800
quote goes out with $2,250 on the button, Snipcart takes its 20%, and the crew
pays $1,800. The quote page shows both numbers.

**The constant and the Snipcart rule have to change together.** A rule live with
`CHECKOUT_DISCOUNT` at 0 undercharges by the rule's rate; the constant left at
0.2 with no rule overcharges by 25%.

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
| `run_worker_first` | in `wrangler.jsonc` — the paths the Worker answers instead of the file router (`/dashboard*`, `/packing-slip*`, `/quote*`, `/logo/*`, `/api/*`) |
| Secrets | `wrangler secret put NAME` — see the table above |
| Quote storage | the `QUOTES` KV namespace |
| Artwork storage | the `LOGOS` R2 bucket (`rawhide-logo-uploads`) |

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
