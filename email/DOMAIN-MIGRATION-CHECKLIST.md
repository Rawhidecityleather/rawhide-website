# Moving tracking emails to orders@rawhidecityleather.com

Written Aug 7 2026. Working checklist — delete this file once it's done and
`PIRATE-SHIP-SETUP.md` has been updated to match.

**Goal:** Pirate Ship tracking emails currently send from `orders@rawhidecitylthr.com`,
the old short domain. Move them to `orders@rawhidecityleather.com` so the from-address
matches the site, without any mail getting rejected on the way.

**The one rule that matters: DNS records go in BEFORE the sender changes.** Zone
`rawhidecityleather.com` is sitting on DMARC `p=reject` with no reporting address. Flip
the sender first and every tracking email is refused outright at Gmail/Yahoo/Outlook,
with no bounce and no report to tell you it happened. Order is everything here.

Nothing is broken today. There is no deadline. Do this when you have an hour and no
orders waiting to ship.

---

## Where things stand (verified Aug 7 2026)

Zone **rawhidecitylthr.com** — working, leave it alone for now:

- TXT `20260708213347pm._domainkey` — Postmark DKIM, present
- CNAME `pm-bounces` -> `pm.mtasv.net` — present
- TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:rawhidecityleather@gmail.com`

Zone **rawhidecityleather.com** — the destination, missing everything:

- MX -> route1/2/3.mx.cloudflare.net, SPF `include:_spf.mx.cloudflare.net` (Cloudflare
  Email Routing, already fine, don't touch)
- TXT `_dmarc` = `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;` — **no `rua=`**
- No DKIM. No `pm-bounces`.

Pirate Ship > Settings > Tracking Emails > "Rawhide Tracking Email" (Default):
Sender Email = `orders@rawhidecitylthr.com`.

---

## Step 0 — Confirm orders@ actually receives on the new domain

`info@rawhidecityleather.com` and `rob@rawhidecityleather.com` are confirmed forwarding
into the business Gmail. `orders@rawhidecityleather.com` is **not confirmed** — no mail
has ever arrived at it. The claim that this rule exists came from the same bad
find-and-replace that started this whole mess, so verify it rather than trust it.

Cloudflare dashboard > rawhidecityleather.com > Email > Email Routing > Routing rules.
Confirm `orders@` -> `rawhidecityleather@gmail.com` exists and the destination is
verified. Create it if it isn't there.

Then send a message from your phone to `orders@rawhidecityleather.com` and confirm it
lands in the Gmail inbox. Customer replies go to this address — it has to work before
you start advertising it on outgoing mail.

## Step 1 — Soften DMARC first, so you can see what's happening

Cloudflare > rawhidecityleather.com > DNS. Edit TXT `_dmarc` to:

```
v=DMARC1; p=none; rua=mailto:rawhidecityleather@gmail.com
```

This does two things: stops hard-rejecting while the DKIM isn't in place yet, and starts
sending aggregate reports so you can actually see pass/fail. Going through this migration
under `p=reject` with no reporting is how you lose mail and never find out.

You will tighten it back in Step 7. Don't skip that.

## Step 2 — Get the new DKIM key out of Pirate Ship

Pirate Ship > Settings > Tracking Emails > **Edit** on "Rawhide Tracking Email". Change
the Sender Email to `orders@rawhidecityleather.com` and save. That prompts Postmark to
create a sender signature for the new domain and gives you a **Verify DKIM** dialog.

Copy out both values it shows:

- the selector, which looks like `20260807xxxxxxpm._domainkey`
- the `k=rsa; p=MIGf...` value

**Do not reuse the old key from `rawhidecitylthr.com`.** Selector `20260708213347pm` is
the keypair Postmark generated for that domain record. A new domain gets its own.

From this moment until Step 5 verifies green, **do not buy a label with a customer email
attached.** The sender has changed but DNS hasn't caught up. If an order comes in mid-way,
either wait or temporarily switch the sender back (see Rollback).

## Step 3 — Add the two records to the rawhidecityleather.com zone

Cloudflare > rawhidecityleather.com > DNS > Add record. Twice:

| Type | Name | Value | Proxy |
|---|---|---|---|
| TXT | `<selector>._domainkey` | `k=rsa; p=MIGf...` from Step 2 | n/a |
| CNAME | `pm-bounces` | `pm.mtasv.net` | **DNS only (grey cloud)** |

The grey cloud on `pm-bounces` is not optional. Proxying it through Cloudflare breaks the
return path — Postmark needs to resolve it to their own infrastructure.

Leave the existing MX, SPF, and Email Routing records alone. Do not add a Postmark
`include:` to SPF; the `pm-bounces` return path is how SPF gets handled.

## Step 4 — Check the records are actually live

```bash
powershell -Command "Resolve-DnsName -Name 'pm-bounces.rawhidecityleather.com' -Type CNAME -Server 1.1.1.1; Resolve-DnsName -Name '_dmarc.rawhidecityleather.com' -Type TXT -Server 1.1.1.1 | Select-Object -ExpandProperty Strings"
```

And the DKIM record, substituting your selector:

```bash
powershell -Command "Resolve-DnsName -Name 'PUT-SELECTOR-HERE._domainkey.rawhidecityleather.com' -Type TXT -Server 1.1.1.1 | Select-Object -ExpandProperty Strings"
```

All three must return a value. If DKIM comes back empty, the record name is wrong —
Cloudflare sometimes appends the domain twice when you paste a full hostname into the
Name field. It should read `<selector>._domainkey`, not
`<selector>._domainkey.rawhidecityleather.com`.

## Step 5 — Verify in Pirate Ship

Back in the Verify DKIM dialog, hit **Verify DKIM** and **Verify Return Path**. Both
need to flip to verified. Postmark re-checks on its own schedule, so this can take a few
hours even with the records live. Don't send anything until both are green.

## Step 6 — Test with a real label

Preview won't prove anything — it doesn't test authentication. Buy the cheapest ground
label to your own address with your own email on it.

When the tracking email arrives, open it in Gmail > three-dot menu > **Show original**
and confirm:

- `DKIM: 'PASS' with domain rawhidecityleather.com`
- `DMARC: 'PASS'`

The domain on the DKIM line matters — it has to say `rawhidecityleather.com`, not
`pm-bounces.postmarkapp.com` or anything else. If it says something else, Postmark is
signing with its own key and alignment will fail once you go back to `p=reject`.

Refund the label in Pirate Ship afterward if you don't use it.

## Step 7 — Tighten DMARC back

Wait about a week and skim the aggregate reports landing in the business Gmail. Once
they're consistently passing, put the strict policy back — but keep the reporting this
time:

```
v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; rua=mailto:rawhidecityleather@gmail.com
```

Expect the reports to show **SPF unaligned** even when everything is healthy. That's
normal and not a problem: the return path is `pm-bounces.rawhidecityleather.com`, a
subdomain, and `aspf=s` demands an exact match. DMARC only needs one of DKIM or SPF to
pass and align, and DKIM will. Don't chase it.

## Step 8 — Clean up

- Update `PIRATE-SHIP-SETUP.md`: sender address, and the DNS section now describes
  `rawhidecityleather.com`.
- Leave the `rawhidecitylthr.com` records in place at least 30 days. They cost nothing
  and they're the rollback.
- Delete this file.

---

## Rollback

If tracking emails start failing at any point, change the Sender Email in Pirate Ship
back to `orders@rawhidecitylthr.com`. That's it — instant, no DNS change, because those
records stay in place the whole time. Fix the new domain at your leisure and try again.
