# Security

Do not post API keys, OAuth JSON, configuration backups, a full management URL, or private conversation content in issues. Revoke exposed credentials with the provider.

For a suspected vulnerability, use this repository's **Security → Report a vulnerability** if available. If private reporting is unavailable, open an issue requesting a private reporting channel without including exploit details or secrets.

The supported security boundary is one Windows user on a personal machine. Only loopback listeners are used; remote provider URLs require HTTPS and credentials are not forwarded across redirects. Management uses a private route token, action-bound CSRF and local Host/Origin checks. The local OS user can access their own data; this is not a boundary against malicious software running as that user.

The optional third-party subscription bridge has a separate local access key and management key. Its OAuth token JSON is protected by filesystem ACLs, not encrypted. New model probes use synthetic prompts and may consume quota; they never execute suggested tools. Updater code only downloads model JSON, never executable updates.
