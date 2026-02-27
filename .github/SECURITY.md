# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest release | :white_check_mark: |
| Older releases | :x: |

## Reporting a Vulnerability

If you discover a security issue, **please do not open a public issue.**

### Preferred: GitHub Security Advisories

Report privately via [Security Advisories](https://github.com/yss-tazawa/plantuml-markdown-preview/security/advisories/new).

### What to include

- Summary of the issue
- Steps to reproduce
- Impact assessment
- Suggested fix (if any)

### Response timeline

1. Acknowledgment within **7 days** of report
2. Severity assessment and fix plan
3. Notification to reporter once a patch is released

## Security Design

This extension is built with security in mind:

- Content Security Policy with nonce-based script restrictions
- No code execution from Markdown content
- User-authored `<script>` tags are blocked
- Local image loading is controlled by `allowLocalImages` (default: on); when disabled, `localResourceRoots` is set to `[]` to block all local file access
- HTTP image loading is off by default (`allowHttpImages`); enabling adds `http:` to the CSP `img-src` directive
- Resolved image URIs are HTML-escaped to prevent attribute injection

See the [Security section in README](../README.md#security) for details.
