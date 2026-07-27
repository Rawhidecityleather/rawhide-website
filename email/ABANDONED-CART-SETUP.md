# Abandoned cart recovery for Rawhide City Leather

**Status: templates written, NOT yet live.** The three emails exist in this folder
but no recovery campaign has been created in Snipcart yet. Everything below is the
setup you need to run once. Like `email/`'s other templates, these files stay in the
repo and are never deployed to the live site (`email/` is listed in `.assetsignore`).

The templates:

| File | Step | Fires |
|---|---|---|
| `abandoned-cart-1-reminder.html` | 1 | ~4 hours after abandonment |
| `abandoned-cart-2-help.html` | 2 | ~24 hours |
| `abandoned-cart-3-lastcall.html` | 3 | ~72 hours |

## Why there is no discount in these emails

Snipcart lets you attach a discount to each recovery step. **Don't.** Three reasons:

1. **There is nothing left to give.** The store is already running 20% off everything
   with free shipping and no minimum. A recovery coupon on top of that cuts into a
   margin that is already discounted.
2. **It might stack.** The sitewide "NEW SITE" 20% discount is set `combinable = TRUE`
   in Snipcart. A recovery discount could compound on top of it rather than replace it.
   Nobody has tested what that does to the total, and an abandoned cart email is a bad
   place to find out.
3. **It teaches the wrong habit.** This is a small niche where buyers talk to each
   other. Train firefighters to abandon a cart and wait for a coupon, and they will.

What actually stalls a $132 custom radio strap is not price. It is a buyer who is not
sure they picked the right length, or who got to the 6 week lead time and hesitated.
That is why step 2 answers those directly instead of waving money.

If the 20% sale ever ends and you want to test a recovery discount, that is the moment
to revisit it, and test one step at a time.

## Setting up the campaign

Snipcart dashboard, two separate places. Templates first, then the campaign.

### 1. Load the templates

**Account → Email settings → Abandoned carts → Edit.**

The editor is code on the left, live preview on the right. Paste one file in, press
**Ctrl+S** to refresh the preview, then **Save & Exit**.

The subject line is the `---` block at the very top of each file. Keep it. That is how
Snipcart reads the subject, and deleting it leaves the email with no subject.

If Snipcart only exposes one abandoned-cart template rather than one per step, load
step 1 as the saved template and keep steps 2 and 3 in this folder until you are ready
to swap them in per step. Check what the campaign editor offers before assuming.

### 2. Build the recovery campaign

**Manage store → Recovery campaigns → new campaign.**

- Name it something like `Standard recovery` (internal only, customers never see it).
- Leave the minimum order value empty so it matches every cart. Snipcart always
  matches a cart to the *most specific* campaign, so if you later add a high-value
  campaign it will take precedence on its own.
- Add three steps at 4 hours, 24 hours, and 72 hours, and attach the matching template
  to each.
- **Attach no discount to any step.** See above.

### 3. Know the one limitation

Carts abandoned *before* you create the campaign will never get these emails. Only
carts abandoned after the campaign exists are matched. So the first few days will look
quiet even when everything is wired correctly.

## Template variables (confirmed against Snipcart's docs)

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

## Testing it

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

Note that test carts from earlier checkout testing already exist in the dashboard
under `test@example.com`. Those are known and can be ignored or removed.

## A dashboard gotcha worth remembering

Claude can click in the Snipcart dashboard but **cannot type into it** — the permission
classifier blocks keystrokes on the live dashboard, and setting values through the
browser console does not persist in Snipcart's UI. So every field here has to be typed
by hand. Pasting the templates is the bulk of the work and there is no way around it.
