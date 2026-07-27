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
