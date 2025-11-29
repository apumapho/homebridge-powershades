# PowerShades Homebridge Plugin - TODO

## Completed Features
- ✅ HTTP keep-alive for API connections (20-30% faster)
- ✅ Shade list caching (5-minute TTL, reduces API calls)
- ✅ Adaptive polling with backoff (1s active, 10s idle, 30s transition)
- ✅ Custom config UI with organized sections
- ✅ All settings configurable via UI
- ✅ PowerShades logo in config UI (base64 encoded)

## Known Limitations / Needs Testing
- **Multi-Property Support**: Not tested with accounts that have multiple properties in PowerShades dashboard. Currently uses account token and returns all shades the API provides. May need property selection in config.

## Future Enhancements (Optional)
- Custom plugin icon (requires building custom UI server)
- Local percentage control via RF gateways (not possible with current firmware - see RF-PROTOCOL.md for details)
- Property selection for multi-property accounts (if needed based on user feedback)
