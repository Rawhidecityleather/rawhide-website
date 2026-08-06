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

Purchase value is Snipcart's actual charged total, so the 20% discount is
already taken out — the numbers in your ad dashboards match real revenue.

### Testing it

1. Paste the IDs, deploy
2. In Google Analytics: **Admin** → **DebugView**, then browse your own site —
   events should appear within a few seconds
3. Place a real $6.40 leather butter order to confirm `purchase` fires with the
   right value, then refund yourself

## Custom build inquiry form (Kit)

The contact page has a real inquiry form that files submissions into Kit. **It
needs a Kit form created before it works.** Until then it safely falls back to
opening an email with everything the visitor typed already filled in — nothing
gets lost, but you should finish the setup.

### 1. Create the Kit form

1. Log into **kit.com** → **Grow** → **Landing Pages & Forms** → **Create new**
2. Choose **Form** → **Inline**, name it `Website Inquiries`
3. Save it, then click **Publish** → **HTML** and find these two values in the
   snippet Kit gives you:
   - The number in `app.kit.com/forms/1234567/subscriptions` → the **form ID**
   - `data-uid="abc123def4"` → the **UID**

### 2. Create the custom fields

In Kit: **Subscribers** → **Custom Fields** → add these four, spelled exactly:

| Field name |
|---|
| `inquiry_type` |
| `department` |
| `needed_by` |
| `details` |

Kit silently drops data sent to fields that don't exist, so this step is not
optional. (`first_name` already exists by default.)

### 3. Point the form at it

In `contact.html`, find the three `KIT_FORM_ID` / `KIT_FORM_UID` placeholders
and replace them:

```html
action="https://app.kit.com/forms/1234567/subscriptions" data-sv-form="1234567" data-uid="abc123def4"
```

### 4. Keep inquiries out of your newsletter list

Inquiries and newsletter signups both land in Kit as subscribers. To stop
sending build questions to people who only wanted the newsletter:

1. **Automate** → **Rules** → **New Rule**
2. Trigger: **Subscribes to a form** → `Website Inquiries`
3. Action: **Add tag** → `inquiry`
4. When you send a newsletter broadcast, filter to subscribers *without* the
   `inquiry` tag

### Known limit

Kit can't accept file uploads, so the form asks people to email sketches and
photos separately. If custom builds pick up and chasing photos by email gets
old, a form backend that takes attachments is the upgrade.

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

Pirate Ship has no API and no Snipcart integration, so labels can't be bought
from the dashboard. What it does take is an address spreadsheet:

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

Two ways, and both do the same three things: save the tracking number, flip the
order to **Shipped**, and let Snipcart email the customer their tracking link.

- **One order** — type the tracking number in its row in the ship queue, hit
  **Ship**.
- **A whole batch** — paste Pirate Ship's shipment list into **Add tracking in
  bulk**. Order number and tracking number per line is all it needs; header rows
  and extra columns are ignored. Anything it can't match to an order gets
  reported back instead of guessed at.

USPS and UPS numbers are told apart automatically, so the tracking link in the
customer's email goes to the right carrier.

### Register the webhook (one time)

This is what makes "tracking number added → Shipped" happen even when the
tracking gets added somewhere else, like Snipcart's own dashboard.

1. Log into **app.snipcart.com** → **Store Configurations** → **Webhooks**
2. Add this URL:
   ```
   https://rawhidecityleather.com/dashboard/hooks/snipcart
   ```
3. Subscribe it to **order.trackingNumber.changed** and **order.completed**

Without this the dashboard still works — the Ship button and the bulk paste set
the status themselves. The webhook only covers tracking numbers that arrive by
some other route. `order.completed` is what closes a quote link the moment it's
paid; without it the link stays live until it expires.

## Quotes for crew and station orders

Live at **/dashboard#quotes**. This is how you bill a crew for a job that isn't
in the catalog — twelve memorial straps, a promotion set, a retirement piece.

You build the quote, they get a link, they pay through the normal checkout. The
order lands like any other, so the ship queue, packing slip, Pirate Ship export
and tracking all work with nothing extra to do.

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
2. **Create quote**, then **Copy** the link and send it to them
3. They open it, hit **Accept & Pay**, and it becomes a normal order

Links expire on the schedule you pick — 30 days by default. **Void** kills one
early if you got a price wrong. A quote that's been paid can't be voided.

The link is public and unguessable. It has to be public: before Snipcart takes
the money it fetches the quote page to check the price against the cart, and it
can't get past a login prompt. Treat the link like a payment link — anyone who
has it can pay it, and nobody who doesn't can find it.

### The sale and quote pricing

**While a sitewide discount is running, the price on the button is grossed up.**
Snipcart's automatic discounts can only be pointed *at* products, never away
from them, so a quote can't sit outside the sale. A $1,800 quote goes out with
$2,250 on the button, Snipcart takes its 20%, and the crew pays $1,800. The
quote page shows both numbers, same as the product pages do.

That means **`CHECKOUT_DISCOUNT` at the top of `worker/quote.js` has to go to 0
when the sale ends**, alongside the announcement bar, the struck-through prices
and the rest of the sale teardown. Leave it at 0.2 with no sale running and
every quote overcharges by 25%.

Outstanding quotes are the reason expiry matters. A link created during the sale
carries the grossed-up price for as long as it lives, so before you switch the
sale off, check **Quotes** for anything still open and void what you don't want
paid at the old arithmetic.

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

All three are already set if the packing slip works. To rotate one:

```bash
npx wrangler secret put SNIPCART_SECRET
```

| Secret | What it's for |
|---|---|
| `SNIPCART_SECRET` | Snipcart **secret** API key. Reads orders, writes tracking and status. Never sent to the browser. |
| `SLIP_USER` | Dashboard username |
| `SLIP_PASS` | Dashboard password |

If `SLIP_USER` or `SLIP_PASS` is missing, the dashboard locks everyone out
rather than opening up.

## Switching from "Email to Order" to PayPal Pay Links

Each product's Buy button is currently a `mailto:` link. When you have PayPal Pay Links:

1. Create a Pay Link per product in PayPal (Account → Pay & Get Paid → PayPal.Me or Payment Links)
2. Open the product page (e.g., `product-helmet-band.html`)
3. Find this line:
   ```html
   <a href="mailto:rawhidecityleather@gmail.com?subject=..." class="btn btn-primary btn-full">Email to Order</a>
   ```
4. Replace `href="mailto:..."` with `href="YOUR_PAYPAL_LINK_HERE"`
5. Change `Email to Order` to `Buy Now`
6. Save the file. Done.

## Deploying to Netlify

### One-time: get your site online (5 minutes)

1. Go to **netlify.com** → click **Sign up** (free, use your Google or email)
2. After signup, click **Add new site** → **Deploy manually**
3. Drag the entire **`rawhide-website` folder** into the browser drop zone
4. Netlify gives you a random URL like `dreamy-leather-7a3f2.netlify.app`
5. Click **Site settings** → **Change site name** → enter `rawhide-city-leather` (or whatever)
6. Your site is live at `https://rawhide-city-leather.netlify.app`

### Connect your domain (rawhidecityleather.com)

1. In Netlify: **Site settings** → **Domain management** → **Add custom domain**
2. Enter `rawhidecityleather.com` → Netlify will check DNS
3. Go to wherever you bought the domain (Wix, GoDaddy, etc.)
4. Find DNS settings → add these records exactly as Netlify shows them:
   - An **A record** pointing to Netlify's IP (Netlify will show you)
   - A **CNAME record** for `www` pointing to your Netlify URL
5. Save DNS, wait 1–24 hours for it to propagate
6. Netlify auto-issues a free SSL certificate (https://) once DNS is connected

### Updating the site later

When you change a file or add a photo:
1. Go to **netlify.com** → your site dashboard
2. Click **Deploys** tab
3. Drag the updated `rawhide-website` folder into the drop zone
4. New version goes live in ~30 seconds

That's it.
