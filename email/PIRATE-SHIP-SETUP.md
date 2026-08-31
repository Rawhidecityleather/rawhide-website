# Pirate Ship setup for Rawhide City Leather

**Status: fully set up and verified on July 8, 2026.** This doc records how it
works and how to change it later.

> **Aug 31, 2026 — moved to a new Pirate Ship account.** Support's answer to the
> three-week sender-signature problem was "create a new account using the email
> address you'd like." That was done and the template rebuilt there:
> "Rawhide Tracking Email", subject "Your Rawhide City Leather gear has shipped",
> branded HTML from this folder, Pirate Ship signature OFF, 1-hour delay, ship-from
> carried over, and the BCC pointed back at the Worker inbox — that address is a
> secret, see the `TRACKING_INBOX` note in `wrangler.jsonc`.
>
> **Their advice did not fix `orders@`.** On the brand-new account, Verify Email →
> Send Confirmation Email returns *"This email address couldn't be verified"* — an
> immediate error, reproduced twice. The *account* email verified fine (that mail
> arrived normally), so account verification and Postmark sender signature are
> separate things and only the second is refused. The sender is now `shipping@`
> instead; see the final status section below.
>
> **Payment method on the new account is empty — add it before buying labels.**

## Root cause of the sender-signature failure (found Aug 31, 2026)

**It is not Cloudflare Email Routing, and not the domain.** Setting the template
sender to `info@rawhidecityleather.com` — same domain, same forwarding, different
local part — was accepted by Postmark immediately, and its "Confirm sender signature"
email arrived in the shop inbox within a minute.

The fault is specific to `orders@rawhidecityleather.com`. That address was the only
one with **no Cloudflare Email Routing rule** when verification was first attempted,
so Postmark's first confirmation email was rejected at Cloudflare's edge, hard
bounced, and the address was suppressed. Adding the rule on Aug 10 fixed receiving
but not the suppression — which is why later resends vanished, and why a brand-new
Pirate Ship account is still refused: the Postmark suppression list is shared across
all Pirate Ship accounts.

> **Rule: create the Cloudflare routing rule FIRST and confirm the address receives
> mail, THEN click Verify.** Verifying an address that has no routing rule poisons it
> permanently and silently. This is the single most important thing in this file.

Cleanest fix is a fresh brand address (e.g. `shipping@`): add its routing rule, let it
receive, then verify. `info@` also works and is already accepted. Getting `orders@`
itself back requires Pirate Ship support to clear it from Postmark suppression.

Confirming any sender signature unlocks **Verify DKIM**, which issues a new selector
for the `rawhidecityleather.com` zone. DKIM is per-domain, so once those records are
added it covers every sender on the domain.

### Status Aug 31, 2026 (final): `shipping@` is the verified sender, records live

`shipping@rawhidecityleather.com` is the template's Sender Email and shows green
**Sender Verified**. Both DNS records are live on the `rawhidecityleather.com` zone
and confirmed resolving against 1.1.1.1:

- TXT `20260810175147pm._domainkey` — full key, ends `IDAQAB`
- CNAME `pm-bounces` → `pm.mtasv.net`, **DNS only** (Cloudflare defaults new CNAMEs to
  Proxied; a proxied return path would break bounce handling — untick it)

Postmark polls DNS on its own schedule, **up to 48 hours**, and there is no "check
now" button — the Verify DKIM / Verify Return Path dialogs only display the records.
The buttons stay blue until Postmark catches up. Re-check in a day or two.

**Worker updated to match (Aug 31, 2026).** With a verified sender, tracking emails
carry `shipping@rawhidecityleather.com` in the **From: header**, not
`ship@pirateship.com`, and `worker/tracking-in.js` matches the allowlist against that
header. `TRACKING_SENDERS` now names all three live senders; left unchanged, every
BCC'd tracking email would have been refused as "sender not on the list" and no order
would have auto-flipped to Shipped.

Re-open the record values any time via **Verify DKIM** / **Verify Return Path** on the
template edit page. **Use the copy buttons — never retype the DKIM key.** One wrong
base64 character breaks signing silently. Some registrars want the name in FQDN form
(`20260810175147pm._domainkey.rawhidecityleather.com`); Cloudflare does not.

The selector is new. Do **not** reuse `20260708213347pm` from the
`rawhidecitylthr.com` zone — that keypair belongs to the other domain.

Once DKIM verifies green, the `_dmarc` ratchet on this zone can finally begin (see the
DMARC section below), but only after auditing the other senders that sign as this
domain — Kit and Brevo.

`info@rawhidecityleather.com` was verified first, while diagnosing, and is still a
valid sender. It is a harmless spare. Note that Pirate Ship caches verification
status: after clicking Postmark's confirm link you must also click the **"click here"**
refresh-validation link on the template edit page before the button turns green.

The email template lives in `email/pirate-ship-tracking-email.html`. This folder is
listed in `.assetsignore`, so it stays in the repo but is never deployed to the live
site. The template pasted into Pirate Ship matches this file; if you edit the file,
re-paste it at **Pirate Ship > Settings > Emails > Rawhide Tracking Email > Edit**.

## How tracking emails work now

- Buying a label on Pirate Ship automatically emails the customer the branded
  "Rawhide Tracking Email" template (set as the account default). A BCC copy goes
  to rawhidecityleather@gmail.com.
- Emails send from **Rawhide City Leather <orders@rawhidecitylthr.com>**, a verified
  Postmark sender signature. (Confirmed in the Pirate Ship UI on Aug 7 2026. The Jul 20
  commit rewrote this line to say `rawhidecityleather.com`, but the actual setting was
  never changed — see the DNS section below.) Customer replies go to orders@, which
  Cloudflare Email Routing forwards to rawhidecityleather@gmail.com.
- The **Track Your Shipment** button links to rawhidecityleather.com/track, which
  detects the carrier from the number (1Z prefix = UPS, all digits = USPS) and
  forwards to live tracking. Buy whichever carrier is cheaper; both work.
- Pirate Ship's "Shipped via your mateys" signature line is turned OFF.
- Default Email Delay is **1 hour** (raised from Immediate on Aug 19, 2026), giving a
  window to refund a mis-bought label before the customer is told. Settings > Emails.

## Template variables (confirmed against Pirate Ship's editor)

`[Recipient First Name]`, `[Tracking #]`, `[Ship Date]`, `[Shipping Service]`.
Also available but unused: `[Recipient Name]`, `[Recipient Address]`, `[Order #]`.
No emoji in the body: Pirate Ship's editor breaks on raw emoji.

## DNS and infrastructure (Cloudflare)

> **Corrected Aug 7 2026 after a DNS audit. Read this before trusting anything above.**
> The Jul 20 "Make rawhidecityleather.com the primary domain" commit (c064c9b) did a
> find-and-replace across this file and rewrote this section to say the mail records
> live in zone `rawhidecityleather.com`. **No DNS records were ever moved.** They are
> all still in zone `rawhidecitylthr.com`, where they were created Jul 8.

Verified against Cloudflare's authoritative nameservers on Aug 7 2026:

**Zone `rawhidecitylthr.com` — where the working mail auth actually lives:**

- Postmark DKIM: TXT `20260708213347pm._domainkey` = `k=rsa; p=MIGfMA0...GwIDAQAB` — present.
- Postmark return path: CNAME `pm-bounces` -> `pm.mtasv.net` — present.
- DMARC: TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:rawhidecityleather@gmail.com` — present.

**Zone `rawhidecityleather.com` — the current primary, missing all of it:**

- No Postmark DKIM record. No `pm-bounces` return path.
- DMARC is `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;` — strict alignment, hard
  reject, and **no `rua=`**, so failures bounce silently with nothing reported anywhere.
  Nobody documented setting this; it did not come from this repo.

Both zones have Email Routing enabled (MX -> route1/2/3.mx.cloudflare.net, SPF
`include:_spf.mx.cloudflare.net`). Those records are Cloudflare-managed and survived.

**Consequence: nothing is broken.** Verified in Pirate Ship > Settings > Tracking Emails
on Aug 7 2026 — the "Rawhide Tracking Email" template (marked Default) has Sender Email
`orders@rawhidecitylthr.com`. That is the zone holding the DKIM, the return path, and a
`p=none` DMARC, so tracking emails sign correctly and deliver. The mismatch was only ever
in this document.

The risk is future: **do not change that sender to `orders@rawhidecityleather.com` until
the DKIM and `pm-bounces` records exist in the `rawhidecityleather.com` zone.** Flipping
it first means every tracking email gets hard-rejected by DMARC `p=reject`, with no
bounce report to tell you.

**Do not copy the old key into the new zone.** The selector `20260708213347pm` is the
keypair Postmark generated for the `rawhidecitylthr.com` domain record. Moving to
`orders@rawhidecityleather.com` means adding that domain in Pirate Ship's Verify DKIM
dialog, which issues a new selector and key — use those.

## Getting orders into Pirate Ship

Pirate Ship has no Snipcart integration and no API, so:

1. Snipcart dashboard > **Orders**, filter status **Processed** (paid, not yet
   shipped), then **Export** to CSV.
2. Pirate Ship > **Ship > Upload a Spreadsheet**, pick the file.
3. First time only: map the columns (name, address 1, address 2, city, state, zip,
   and optionally email + order number) and **save the mapping** named `Snipcart`.
   Include the email column so tracking emails send on label purchase.
4. For a single order it is often faster to copy the address from the Snipcart
   order page into Pirate Ship's Quick Rate form (include the email there too).

If the Snipcart CSV export turns out not to include full shipping addresses, a
small export tool can be built against the Snipcart API.

## After shipping: close the loop in Snipcart

Set the order status to **Shipped** in Snipcart for bookkeeping. When Snipcart pops
up asking whether to email the tracking number to the customer, **decline it**:
Pirate Ship already sent the branded email, and accepting would double-email the
customer.

## DMARC

Added July 8, 2026 **to zone rawhidecitylthr.com**: TXT `_dmarc` =
`v=DMARC1; p=none; rua=mailto:rawhidecityleather@gmail.com`. Monitor-only (blocks
nothing, sends aggregate reports to the business gmail). Still in place as of Aug 7 2026.

The plan was to tighten to `p=quarantine` and later `p=reject` after a few quiet weeks
of reports. That never happened on this zone.

Zone `rawhidecityleather.com` carries a different, much harsher record that skipped
the whole ramp: `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;` with no `rua=`.
Strict alignment plus hard reject plus zero reporting is the worst combination to sit
on while DKIM is missing — mail gets refused and nothing tells you. Before sending any
mail from this domain, either add the DKIM record (see above) or drop it back to
`p=none` with a `rua=` while things get sorted.
