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
