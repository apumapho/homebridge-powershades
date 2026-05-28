# PowerShades RF Channel Mapping Template

This file is a public-safe template. Do not commit real gateway IPs, serial numbers, room names, shade names, shade IDs, device IDs, or other home-specific details.

Use a private ignored file such as `private-docs/rf-channel-mapping.md` for your real mapping.

## Gateway A

| RF channel | Shade name | Shade id | Device id | Room |
| --- | --- | ---: | ---: | --- |
| 1 | Example Shade | 00000 | 00000 | Example Room |

## Gateway B

| RF channel | Shade name | Shade id | Device id | Room |
| --- | --- | ---: | ---: | --- |
| 1 | Example Shade | 00000 | 00000 | Example Room |

## Notes

- Capture mappings by issuing unique cloud target percentages per shade and correlating the command with gateway `debug.shtml` output.
- Prefer `SCH ExeNextAct ... CH[...] PCT N` evidence where `N` is the unique target percentage used for that shade.
- Cloud metadata fields such as `Window` may not equal RF gateway channels.
