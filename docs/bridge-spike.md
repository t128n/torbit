# Bridge intake spike (upstream v0.4.1)

Results of the three open checks from spec #6. Paths are relative to the
Orbit checkout; `S` is `apps/server/src`.

## Checks

1. **Neutral verdicts: yes.** `crates/mail/src/auth.rs` has `Verdict::None` and
   `Neutral` (line 48), `DmarcVerdict::None` (71), and `AuthOutcome` with public
   fields (80). `S/mail_listener.rs:488` already builds a neutral value. Spam is
   chosen only on a DMARC `Fail` (`S/repositories/mail/ingest.rs:243`).
2. **Recipient lookup with the `.invalid` domain: yes.** `S/repositories/mail/mailboxes.rs:255`
   needs only `status = 'verified'`; a provider is not required. The bridge skips
   `lookup_recipient` and builds `Recipient::Mailbox` directly. Domain names are
   unique across the instance (`migrations/20261111122204_mail.sql:103`), so the
   reserved name must contain the workspace id.
3. **Intake stays on with mail: yes, with a caveat.** `S/app.rs:364-388` builds
   provider intake independently of `ORBIT_MAIL_ENABLED` (which gates only the SMTP
   listener, line 347). The bridge route must check the instance mail setting itself
   and use its own `MailIntake`, not `state.inbound`.

## Design adjustments

- **Body cap:** non-multipart bodies are capped at 2 MiB
  (`crates/platform/src/http/limits.rs:36`). Document 2 MiB as the effective limit
  or exempt the bridge path.
- **Route prefix:** mount delivery at `/api/v1/mail/inbound/bridge/{device_id}` to reuse
  the Origin exemption (`crates/platform/src/http/security.rs:99`).
- **`Source` enum** (`S/mail_intake.rs:31`) needs a `Bridge` variant. The column is free text.
- **Mailbox creation:** `create_mailbox` needs owner/admin (`mailboxes.rs:801`). A member
  needs a new insert path. A member with an existing personal mailbox reuses it.
- **DNS skip:** put it in `DnsChecker::check_domain` (`S/mail_dns.rs:822`), so the daily
  sweep and "Check now" both skip `.invalid` domains.
- **Config:** unknown `ORBIT_*` names are rejected, so `crates/platform/src/config.rs`
  needs a constant, parser and field for the registry path.
- **Enrollment auth:** there is no mail token scope. Enrollment accepts an Orbit session
  (and an API token if the existing extractor allows it without a scope).
- **OpenAPI:** register new routes in `S/openapi.rs`.
