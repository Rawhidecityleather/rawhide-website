# Pirate Ship setup for Rawhide City Leather

Two pieces: (1) getting Snipcart orders into Pirate Ship, (2) the branded tracking
email Pirate Ship sends the customer when you buy a label.

The email template lives in `email/pirate-ship-tracking-email.html`. This folder is
listed in `.assetsignore`, so it stays in the repo but is never deployed to the live
site.

## 1. Customize the tracking email (one-time, ~10 min)

1. Log in at pirateship.com, go to **Settings > Tracking Emails > Edit**.
2. Before touching anything, look at the blue variable chips above the editor and
   note their exact wording. The template uses these four:
   - `[Recipient First Name]`
   - `[Tracking Number]`
   - `[Ship Date]`
   - `[Shipping Service]`
   If Pirate Ship's chips are worded differently, do a find and replace in the
   template so the tokens match theirs character for character.
3. Switch the editor to HTML view and replace the default template with the full
   contents of `pirate-ship-tracking-email.html` (everything including the top
   comment is safe to paste; the comment is invisible to customers).
4. Set the **Subject** to: `Your Rawhide City Leather gear has shipped`
5. Set the **From name** to: `Rawhide City Leather`
6. If it asks you to verify a sender email address, use rawhidecityleather@gmail.com
   and click the verification link it sends.
7. Put rawhidecityleather@gmail.com in **Send copies to (BCC)** so you get a copy of
   every tracking email.
8. Optional: **Default Email Delay** controls when the email goes out after you buy
   the label. Leave at default, or delay a few hours if you sometimes buy labels the
   night before drop-off.

### Test it

Buy one cheapest-rate label addressed to yourself (a few dollars, refundable within
30 days if unused). Confirm on your phone:

- Logo loads, layout looks right in Gmail
- Your first name appears in the greeting (variables merged, no raw brackets)
- The tracking number shows in the stamp box
- The **Track Your Shipment** button opens rawhidecitylthr.com/track and forwards
  to the right carrier's live tracking with the number filled in

If the track page says it could not recognize the number, or you see raw brackets
in the URL, the variable name did not match: fix the token in the button href to
match Pirate Ship's chip exactly.

### Notes

- The track button points to rawhidecitylthr.com/track, a page on the site that
  reads the tracking number and forwards to UPS or USPS automatically (UPS numbers
  start with 1Z, USPS numbers are all digits). Buy whichever carrier is cheaper per
  package; the email works for both. If Pirate Ship's editor shows a ready-made
  tracking link variable chip, you can use that in the button href instead.
- No emoji in the email body: Pirate Ship's editor breaks on raw emoji.
- Later upgrade if you want emails sent from @rawhidecitylthr.com instead of via
  Pirate Ship: they support custom sender domains with DKIM records, which go in
  Cloudflare DNS. Ask me and I'll walk through it.

## 2. Getting orders into Pirate Ship

Pirate Ship has no Snipcart integration and no API, so the clean path is CSV:

1. Snipcart dashboard > **Orders**, filter status **Processed** (paid, not yet
   shipped), then **Export** to CSV.
2. Pirate Ship > **Ship > Upload a Spreadsheet**, pick the file.
3. First time only: map the columns (name, address 1, address 2, city, state, zip,
   and optionally email + order number) and **save the mapping** named `Snipcart`.
   Every later import is two clicks.
4. Buy the labels. Pirate Ship emails each customer the branded tracking email
   automatically.

For a single order it is often faster to just copy the address from the Snipcart
order page into Pirate Ship's Quick Rate form.

If the Snipcart CSV export turns out not to include full shipping addresses, tell me
and I will build a small button that pulls orders from the Snipcart API and produces
a Pirate Ship-ready CSV.

## 3. After shipping: close the loop in Snipcart

In Snipcart, open the order and set status to **Shipped** (good bookkeeping, and it
is where you paste the tracking number for your own records). When Snipcart pops up
asking whether to email the tracking number to the customer, **decline it**. Pirate
Ship already sent the branded email; letting Snipcart send its own means the
customer gets two tracking emails.
