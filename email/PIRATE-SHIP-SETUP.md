# Pirate Ship setup for Rawhide City Leather

**Status: fully set up and verified on July 8, 2026.** This doc records how it
works and how to change it later.

The email template lives in `email/pirate-ship-tracking-email.html`. This folder is
listed in `.assetsignore`, so it stays in the repo but is never deployed to the live
site. The template pasted into Pirate Ship matches this file; if you edit the file,
re-paste it at **Pirate Ship > Settings > Emails > Rawhide Tracking Email > Edit**.

## How tracking emails work now

- Buying a label on Pirate Ship automatically emails the customer the branded
  "Rawhide Tracking Email" template (set as the account default). A BCC copy goes
  to rawhidecityleather@gmail.com.
- Emails send from **Rawhide City Leather <orders@rawhidecitylthr.com>**, a
  verified Postmark sender signature. Customer replies go to orders@, which
  Cloudflare Email Routing forwards to rawhidecityleather@gmail.com.
- The **Track Your Shipment** button links to rawhidecitylthr.com/track, which
  detects the carrier from the number (1Z prefix = UPS, all digits = USPS) and
  forwards to live tracking. Buy whichever carrier is cheaper; both work.
- Pirate Ship's "Shipped via your mateys" signature line is turned OFF.
- Default Email Delay is **Immediate**. If you want a refund-safety window after
  buying labels, raise it in Settings > Emails.

## Template variables (confirmed against Pirate Ship's editor)

`[Recipient First Name]`, `[Tracking #]`, `[Ship Date]`, `[Shipping Service]`.
Also available but unused: `[Recipient Name]`, `[Recipient Address]`, `[Order #]`.
No emoji in the body: Pirate Ship's editor breaks on raw emoji.

## DNS and infrastructure (all in Cloudflare, zone rawhidecitylthr.com)

- **Email Routing**: enabled; rule orders@rawhidecitylthr.com -> forward to
  rawhidecityleather@gmail.com (destination verified). Managed under
  Email > Email Routing. Its MX/SPF/DKIM records are locked by Cloudflare.
- **Postmark DKIM** (added Jul 8 2026): TXT `20260708213347pm._domainkey` with the
  `k=rsa; p=...` value from Pirate Ship's Verify DKIM dialog.
- **Postmark return path**: CNAME `pm-bounces` -> `pm.mtasv.net`, DNS only.
- Pirate Ship's Verify DKIM / Verify Return Path buttons flip to verified
  automatically once Postmark re-checks the records (can take a few hours; the
  records are live and were confirmed by DNS query).

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

Added July 8, 2026: TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:rawhidecityleather@gmail.com`.
Monitor-only for now (blocks nothing, sends occasional aggregate reports to the
business gmail). After a few quiet weeks, tighten to `p=quarantine` and later
`p=reject` by editing that record in Cloudflare DNS.
