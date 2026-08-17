# Order confirmations: moving off Snipcart's shared SendGrid

Written Aug 14 2026. Working checklist — delete this file once it's done.

> **Scope note, Aug 17 2026.** This file is **only** about order confirmations.
> Abandoned cart recovery does *not* need SendGrid and does not wait on this —
> it sends through Brevo's free tier instead (see `ABANDONED-CART-SETUP.md` and
> `worker/mailer.js`). Snipcart's settings field is SendGrid-specific, so
> SendGrid remains the only option for *this* problem, and the $19.95/mo below
> buys exactly one thing: order confirmations that stop landing in trash.
>
> The $19.95 figure is now **confirmed** — SendGrid ended its permanent free
> tier in May 2025, leaving a 60-day trial and then Essentials at $19.95/mo for
> 50K emails. Step 0's "check the real price on the signup screen" still applies,
> but it is no longer an unverified third-party number.

**Goal:** order confirmation emails are landing in customers' trash. Snipcart sends
them on `order.completed` through **its own shared SendGrid account** — no API key of
ours, no authenticated domain. Verified in the dashboard Aug 10 2026: the API key field
reads "No API key" and the Authenticate Email Domain table is empty.

That matters because it means **no DNS record on any zone we control can fix this.**
Deliverability is riding entirely on the sender reputation of an account shared with
every other Snipcart store. The only lever is putting our own SendGrid account behind
it and authenticating `rawhidecityleather.com` so the mail is signed as us.

This is separate from the Pirate Ship tracking-email work in
`DOMAIN-MIGRATION-CHECKLIST.md`. Different sender, different provider, different
problem. Neither blocks the other.

---

## Step 0 — The cost gate. Decide this before creating an account.

SendGrid's permanent free tier is gone. As best I can tell it became a **60-day trial**
in 2025 (100 emails/day during the trial), after which it's **$19.95/mo minimum** —
about $240/yr. I could not confirm this on Twilio's own pricing page, which renders
its numbers in JavaScript; the figures come from third-party pricing trackers. **Check
the real price on the signup screen before committing.**

Volume is not the issue — at current order rate this is a handful of emails a month,
nowhere near any plan's limit. The question is purely whether $240/yr is worth fixing
order confirmation deliverability.

Worth knowing before you decide:

- **Snipcart's field is SendGrid-specific.** There's no cheaper provider to swap in.
  It's SendGrid or stay on the shared account.
- **Doing nothing is a real option.** Confirmations still send, they just land badly.
- **There's a third path, but it's a build, not a config:** Snipcart webhooks could
  fire our own confirmation email through any provider. More control, more to maintain,
  and not a thing you configure in an afternoon.

If the answer is no, stop here and leave this file for later.

---

## Step 1 — Create the SendGrid account

Yours to do. Use `rawhidecityleather@gmail.com`. During signup it asks for a Single
Sender identity — that's a stopgap and not what we want; domain authentication in
Step 2 is the real fix.

## Step 2 — Domain authentication

SendGrid > Settings > Sender Authentication > Authenticate Your Domain.

- DNS host: **Cloudflare**
- Domain: **`rawhidecityleather.com`** — the storefront domain, the one customers check
  out on. Not `rawhidecitylthr.com`. The whole point is that the from-address matches
  where they bought.
- Leave **Automated Security ON**. That gives CNAME records SendGrid can rotate keys
  behind, instead of a TXT key you'd have to hand-update.

It then shows three CNAMEs, roughly:

| Type | Name | Value |
|---|---|---|
| CNAME | `em####` | `u#######.wl###.sendgrid.net` |
| CNAME | `s1._domainkey` | `s1.domainkey.u#######.wl###.sendgrid.net` |
| CNAME | `s2._domainkey` | `s2.domainkey.u#######.wl###.sendgrid.net` |

Copy them exactly. The numbers are account-specific.

## Step 3 — Add them in Cloudflare

Cloudflare > rawhidecityleather.com > DNS > Add record, three times.

**Every one of them must be DNS only — grey cloud, not orange.** Same trap as
`pm-bounces` in the Pirate Ship migration: proxying a mail CNAME through Cloudflare
breaks it, because SendGrid needs it resolving to their infrastructure.

Two things not to touch:

- **MX records stay exactly as they are.** Cloudflare Email Routing handles all inbound
  mail for this domain — `orders@`, `info@`, `rob@` all forward into the business Gmail.
  Domain authentication is outbound only and doesn't conflict.
- **Don't add a SendGrid `include:` to SPF** unless SendGrid explicitly tells you to.
  The `em####` CNAME is the return path and handles it.

Also watch the Name field — Cloudflare sometimes appends the domain twice when you
paste a full hostname. It should read `s1._domainkey`, not
`s1._domainkey.rawhidecityleather.com`.

## Step 4 — Confirm the records resolve

```bash
powershell -Command "'s1._domainkey','s2._domainkey' | ForEach-Object { Resolve-DnsName -Name \"$_.rawhidecityleather.com\" -Type CNAME -Server 1.1.1.1 }"
```

All must return a value before you click verify. Cloudflare is usually under an hour.

## Step 5 — Verify in SendGrid

Back on the Sender Authentication screen, hit Verify. If it fails, it's almost always
an orange cloud or a doubled hostname from Step 3.

## Step 6 — Create the API key

SendGrid > Settings > API Keys > Create API Key.

- **Restricted Access**, with **Mail Send** as the only permission enabled. Nothing else.
- It's shown **once**. Put it straight in a password manager.
- Don't paste it into chat, a file in this repo, or a commit. It's a send-as-you
  credential.

## Step 7 — Put it in Snipcart

`https://app.snipcart.com/dashboard/sendgrid-settings` — that's the sidebar link's real
href, not the `/dashboard/settings/x` pattern used elsewhere. Deep-linking a guessed
URL renders a blank shell.

**Check the sidebar reads LIVE before you touch anything.** The LIVE/TEST toggle is
easy to flip by accident going through the hamburger menu, and settings don't carry
across modes.

Paste the key, save. Then add `rawhidecityleather.com` in the Authenticate Email Domain
table on the same page.

## Step 8 — Test with a real order

Place a small real order in LIVE mode with your own email on it, then refund it.

When the confirmation arrives, Gmail > three-dot menu > **Show original** and confirm:

- `DKIM: 'PASS' with domain rawhidecityleather.com`
- `DMARC: 'PASS'`

The domain on the DKIM line is the part that matters. If it says `sendgrid.net` or
`snipcart.com` instead, the key didn't take and it's still going out on the shared
account.

## Step 9 — Watch, then tighten

`_dmarc.rawhidecityleather.com` is currently `p=none; rua=mailto:rawhidecityleather@gmail.com`
(softened Aug 10 2026). Aggregate reports for this domain will start arriving in the
business Gmail once SendGrid begins sending as it — right now there are none, because
nothing sends as this domain yet.

**Do not ratchet that policy up until both senders are authenticated in this zone.**
Eventually two different services will sign as `rawhidecityleather.com`: SendGrid for
order confirmations, and Postmark for tracking emails once the Pirate Ship migration
finishes. Going to `p=reject` with only one of them in place silently kills the other.

---

## Rollback

Clear the API key out of Snipcart. Confirmations revert to the shared SendGrid account
immediately — same behavior as today, no DNS change needed. The CNAMEs can stay; they
cost nothing and they're what you'd need again on a second attempt.
