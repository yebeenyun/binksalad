# Binksalad implementation checklist

## Delivered local MVP

- [x] Responsive Korean finance UI with mobile navigation and live API data.
- [x] Owner first-run setup, username/password login, logout, expiring sessions, CSRF checks, and login throttling.
- [x] SQLite persistence for households, members, account labels, categories, transactions, imports, credentials, notifications, and audit history.
- [x] Manual transaction create/edit/delete, keyword/type/category/month filters, and audit records.
- [x] Server-side XLSX upload, KakaoBank-style column recognition, optional password-protected workbook decryption, row validation, editable preview, and import history.
- [x] Duplicate detection, atomic import writes, optional AES-256-GCM password storage, credential deletion, and learned merchant/category rules.
- [x] Database-derived monthly totals, six-month trends, expense categories, top merchants, recurring-payment candidates, and month-over-month increase insights.
- [x] Import notifications with read/unread state.
- [x] Shared-household one-time invitations with seven-day expiry, hashed invitation tokens, membership listing/removal, and read/edit permissions.
- [x] Enforce read-only members on transaction changes, statement imports, and saved-credential deletion.
- [x] Create KakaoBank account labels, select an account for each statement import, and deduplicate within the selected account.
- [x] Internal-network launcher and temporary Cloudflare HTTPS launcher.
- [x] Smoke-test first-run setup, reload persistence, empty dashboard, and no horizontal overflow at mobile width.
- [x] README documentation in Korean and English.
- [x] End-to-end test for setup, authentication, manual transactions, import/deduplication, category learning, analytics, notification state, and credential deletion.

## Remaining product requirements

- [ ] Inspect and validate the encrypted KakaoBank reference workbook using its actual password; the password was not provided.
- [x] Add official Kakao OAuth authorization-code login and account linking.
- [ ] Configure real Kakao Developer credentials and complete a live provider callback test.
- [ ] Add Kakao profile management and Kakao app-side unlink/revoke behavior.
- [ ] Add household creation/switching and joining an existing household with an already-created Binksalad account. Invitation signup, member management, and read/edit permissions are implemented.
- [ ] Implement and verify direct KakaoBank account discovery through an authorized official integration, if available. Current workflow uses user-downloaded XLSX files and local account labels.
- [ ] Add date-range filters and household filters to transaction search.
- [ ] Reproduce and verify all historical formulas and classifications in the reference household workbook.
- [ ] Add quarterly, annual, and year-over-year reports; broaden recurring and unusual-spending analysis.
- [ ] Add detailed transaction-level contributors to spending-change explanations and optional AI-generated insights grounded in verified data.
- [ ] Add notification preferences, analysis-complete/invitation notifications, and optional email/push delivery.
- [ ] Add automated database/key backups and production key-management/deployment hardening.
- [ ] Test wrong-password behavior with a known encrypted fixture, complete mobile workflows, and tunnel operation with `cloudflared` installed.
- [ ] Run security testing and verify authorization/data isolation after multi-user support is implemented.

## Release status

This is a working, data-backed app with invitation-based shared household access, account-labeled statement imports, and role-enforced read-only members. Kakao Login is implemented but requires app credentials and a stable registered redirect URI for a live callback test. KakaoBank account listing is not directly integrated: users select a local account label when importing a downloaded statement. Household switching, direct bank integration, and other remaining requirements above are incomplete. External access requires the owner account to be initialized locally first. The temporary tunnel and encrypted bank reference still need validation with the required provider URL and workbook password.
