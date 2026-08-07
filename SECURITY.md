# Security Policy

## Supported versions

Only the latest released minor version receives security fixes. Takonaut may
block obsolete Runner versions when a protocol or sandbox defect makes
continued use unsafe.

## Reporting a vulnerability

Email **<security@takonaut.com>** with the affected version, reproduction steps,
impact, and any proposed remediation. Do not include production credentials,
customer source code, or raw Run transcripts.

Please do not open a public issue until Takonaut confirms that a coordinated
disclosure is safe. We will acknowledge receipt, investigate, and provide
status updates through the reporting channel.

## Security boundaries

Tako Runner executes on customer-controlled infrastructure under the
installing user's operating-system account. It is not a VM or general-purpose
sandbox. Assign only trusted private repositories and use a dedicated
low-privilege account for shared Runner hosts.

Machine credentials must never be committed, passed in command arguments, or
included in logs. Revoke a machine immediately from Takonaut if its credential
or host may be compromised.

Writable directory ancestors are rejected because another local account could
replace Runner configuration, credentials, or repository paths. The temporary
`--allow-unsafe-ancestor ABSOLUTE_PATH` override accepts only the named ancestor
and must be repeated for every command. It does not relax ownership, symlink,
credential-mode, or nested writable-directory checks. Use it only for a
controlled foreground test, never as the default for a shared Runner host.

Browser enrollment is only a consent transport. It creates the same
organization-owned Runner machine credential as key-based enrollment and never
installs a Tako Bridge or human-session credential. Approve a code only when
the displayed organization, machine name, capacity, and Project allowlist are
all expected. If credential delivery is interrupted after enrollment, rotate
or revoke the reported Runner before retrying.
