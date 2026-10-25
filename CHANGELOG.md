# Changelog

## 2.4.0

First general-purpose source release.

- Add a first-install entry point with explicit directory/port settings, protected local bootstrap, health-before-activation and preserving upgrade.
- Keep original ChatGPT login and native GPT models while adding independent compatible API providers.
- Preserve installed account catalogs when upgrading from empty source-release seeds.
- Keep provider credentials, personal model caches, runtime binaries and diagnostic artifacts out of source releases.
- Discover initial optional Gemini models from the account catalog rather than a fixed personal model list; require explicit opt-in to the third-party subscription adapter.
- Include Chinese/English setup guidance, recovery and security documentation, locked dependencies and Windows CI.
- Include synthetic protocol, signature isolation, management, discovery, first-install and scheduled lifecycle checks.
